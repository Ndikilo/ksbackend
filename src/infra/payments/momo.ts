import { Config, Context, Effect, Layer } from "effect";
import { z } from "zod";

import {
  type ChargeStatus,
  type InitiateChargeInput,
  type InitiatedCharge,
  type PaymentProviderService,
  type ProviderHttpDeps,
  PaymentProviderError,
  defaultFetchJson,
  normalizeMsisdn,
  requireCredential,
  validateChargeInput,
} from "./provider";

/**
 * MTN MoMo Collections adapter (P5.T1) — the documented sandbox contract
 * (https://sandbox.momodeveloper.mtn.com, "Collections"):
 *
 *   1. POST /collection/token/             Basic apiUser:apiKey → access_token
 *   2. POST /collection/v1_0/requesttopay  202 — idempotent via `X-Reference-Id`
 *   3. GET  /collection/v1_0/requesttopay/{referenceId} → { status }
 *
 * A fresh token is fetched per operation (stateless adapter — no Clock, no
 * cache invalidation; the extra round-trip is fine for clinic-scale traffic).
 */

export class MomoProvider extends Context.Tag("MomoProvider")<
  MomoProvider,
  PaymentProviderService
>() {}

const TokenResponse = z.object({ access_token: z.string().min(1) });

const RequestToPayStatus = z.object({
  status: z.enum(["PENDING", "SUCCESSFUL", "FAILED"]),
});

const toChargeStatus = (status: "PENDING" | "SUCCESSFUL" | "FAILED"): ChargeStatus =>
  status === "SUCCESSFUL" ? "succeeded" : status === "FAILED" ? "failed" : "pending";

const httpError = (
  kind: PaymentProviderError["kind"],
  message: string,
  httpStatus?: number,
): PaymentProviderError =>
  httpStatus === undefined
    ? new PaymentProviderError({ kind, message })
    : new PaymentProviderError({ kind, message, httpStatus });

export const makeMomoProvider = (
  deps: ProviderHttpDeps & {
    readonly subscriptionKey: string;
    readonly apiUser: string;
    readonly apiKey: string;
    readonly targetEnv: string;
  },
): PaymentProviderService => {
  const { baseUrl, fetchJson } = deps;

  const accessToken: Effect.Effect<string, PaymentProviderError> = Effect.tryPromise({
    try: () =>
      fetchJson(`${baseUrl}/collection/token/`, {
        method: "POST",
        headers: {
          Authorization: `Basic ${btoa(`${deps.apiUser}:${deps.apiKey}`)}`,
          "Ocp-Apim-Subscription-Key": deps.subscriptionKey,
        },
      }),
    catch: () => httpError("provider", "MoMo token request failed"),
  }).pipe(
    Effect.filterOrFail(
      (response) => response.status === 200,
      (response) =>
        httpError("provider", `MoMo token endpoint answered ${response.status}`, response.status),
    ),
    Effect.flatMap((response) =>
      Effect.try({
        try: () => TokenResponse.parse(response.body),
        catch: () =>
          httpError("unexpected_response", "MoMo token response did not match the contract"),
      }),
    ),
    Effect.map((token) => token.access_token),
  );

  const authorizedHeaders = (token: string) => ({
    Authorization: `Bearer ${token}`,
    "X-Target-Environment": deps.targetEnv,
    "Ocp-Apim-Subscription-Key": deps.subscriptionKey,
  });

  return {
    id: "momo",

    initiate: (input: InitiateChargeInput): Effect.Effect<InitiatedCharge, PaymentProviderError> =>
      Effect.gen(function* () {
        yield* requireCredential(deps.subscriptionKey, "MOMO_SUBSCRIPTION_KEY");
        yield* requireCredential(deps.apiKey, "MOMO_API_KEY");
        yield* validateChargeInput(input);
        const token = yield* accessToken;

        // 202 Accepted, empty body. `X-Reference-Id` is the idempotency key —
        // a retry with the same reference re-attaches to the SAME charge.
        const response = yield* Effect.tryPromise({
          try: () =>
            fetchJson(`${baseUrl}/collection/v1_0/requesttopay`, {
              method: "POST",
              headers: {
                ...authorizedHeaders(token),
                "Content-Type": "application/json",
                "X-Reference-Id": input.referenceId,
              },
              body: JSON.stringify({
                amount: String(input.amountXaf),
                currency: "XAF",
                externalId: input.referenceId,
                payer: { partyIdType: "MSISDN", partyId: normalizeMsisdn(input.payerPhone) },
                payerMessage: input.description,
                payeeNote: input.description,
              }),
            }),
          catch: () => httpError("provider", "MoMo requesttopay call failed"),
        });

        if (response.status !== 202) {
          // 409 = the reference was seen before — an idempotent retry landing
          // on the same pending charge, not a failure.
          if (response.status === 409) {
            return { providerChargeId: input.referenceId, status: "pending" as const };
          }
          return yield* Effect.fail(
            httpError(
              response.status >= 400 && response.status < 500 ? "declined" : "provider",
              `MoMo requesttopay answered ${response.status}`,
              response.status,
            ),
          );
        }
        return { providerChargeId: input.referenceId, status: "pending" as const };
      }),

    status: (providerChargeId: string): Effect.Effect<ChargeStatus, PaymentProviderError> =>
      Effect.gen(function* () {
        yield* requireCredential(deps.subscriptionKey, "MOMO_SUBSCRIPTION_KEY");
        const token = yield* accessToken;
        const response = yield* Effect.tryPromise({
          try: () =>
            fetchJson(
              `${baseUrl}/collection/v1_0/requesttopay/${encodeURIComponent(providerChargeId)}`,
              { method: "GET", headers: authorizedHeaders(token) },
            ),
          catch: () => httpError("provider", "MoMo status call failed"),
        });
        if (response.status === 404) {
          return yield* Effect.fail(
            httpError("unexpected_response", `MoMo knows no charge ${providerChargeId}`, 404),
          );
        }
        if (response.status !== 200) {
          // 5xx and oddballs are upstream trouble; contract violations on a
          // 2xx are unexpected_response below.
          return yield* Effect.fail(
            httpError("provider", `MoMo status answered ${response.status}`, response.status),
          );
        }
        const decoded = yield* Effect.try({
          try: () => RequestToPayStatus.parse(response.body),
          catch: () =>
            httpError("unexpected_response", "MoMo status response did not match the contract"),
        });
        return toChargeStatus(decoded.status);
      }),
  };
};

/**
 * Production/sandbox adapter. Env-configured (`.env.schema`); credentials are
 * a deploy-time user action — unset creds fail per call (`not_configured`),
 * never at boot, so payments stay optional infrastructure until P5.T3.
 */
export const MomoProviderLive = Layer.effect(
  MomoProvider,
  Effect.gen(function* () {
    const baseUrl = yield* Config.string("MOMO_BASE_URL").pipe(
      Config.withDefault("https://sandbox.momodeveloper.mtn.com"),
    );
    const subscriptionKey = yield* Config.string("MOMO_SUBSCRIPTION_KEY").pipe(
      Config.withDefault(""),
    );
    const apiUser = yield* Config.string("MOMO_API_USER").pipe(Config.withDefault(""));
    const apiKey = yield* Config.string("MOMO_API_KEY").pipe(Config.withDefault(""));
    const targetEnv = yield* Config.string("MOMO_TARGET_ENV").pipe(Config.withDefault("sandbox"));
    return makeMomoProvider({
      baseUrl,
      subscriptionKey,
      apiUser,
      apiKey,
      targetEnv,
      fetchJson: defaultFetchJson,
    });
  }),
);
