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
 * Orange Money Web Payment adapter (P5.T1) — the documented sandbox contract
 * (https://developer.orange.com, "Web Payment API"; the `/dev/v1` path IS the
 * sandbox):
 *
 *   1. POST /oauth/v3/token                  client_credentials → access_token
 *   2. POST /orange-money-webpay/dev/v1/webpayment → { payToken, statusUrl, message }
 *   3. GET  /orange-money-webpay/dev/v1/webpayment/status/{payToken} → { status }
 *
 * `orderId`/`reference` carry our idempotency key; the user approves on
 * `statusUrl` (returned to the client by the checkout layer, P5.T3).
 */

export class OrangeMoneyProvider extends Context.Tag("OrangeMoneyProvider")<
  OrangeMoneyProvider,
  PaymentProviderService
>() {}

const TokenResponse = z.object({ access_token: z.string().min(1) });

const InitiateResponse = z.object({
  payToken: z.string().min(1),
  statusUrl: z.string().url(),
  message: z.string(),
});

const PaymentStatusResponse = z.object({
  status: z.enum(["INITIATED", "SUCCESS", "FAILED", "EXPIRED"]),
});

const toChargeStatus = (status: "INITIATED" | "SUCCESS" | "FAILED" | "EXPIRED"): ChargeStatus =>
  status === "SUCCESS" ? "succeeded" : status === "INITIATED" ? "pending" : "failed";

const httpError = (
  kind: PaymentProviderError["kind"],
  message: string,
  httpStatus?: number,
): PaymentProviderError =>
  httpStatus === undefined
    ? new PaymentProviderError({ kind, message })
    : new PaymentProviderError({ kind, message, httpStatus });

export const makeOrangeMoneyProvider = (
  deps: ProviderHttpDeps & {
    readonly clientId: string;
    readonly clientSecret: string;
    readonly merchantKey: string;
    readonly returnUrl: string;
    readonly cancelUrl: string;
    readonly notifUrl: string;
  },
): PaymentProviderService => {
  const { baseUrl, fetchJson } = deps;

  const accessToken: Effect.Effect<string, PaymentProviderError> = Effect.tryPromise({
    try: () =>
      fetchJson(`${baseUrl}/oauth/v3/token`, {
        method: "POST",
        headers: {
          Authorization: `Basic ${btoa(`${deps.clientId}:${deps.clientSecret}`)}`,
          "Content-Type": "application/x-www-form-urlencoded",
          Accept: "application/json",
        },
        body: "grant_type=client_credentials",
      }),
    catch: () => httpError("provider", "Orange token request failed"),
  }).pipe(
    Effect.filterOrFail(
      (response) => response.status === 200,
      (response) =>
        httpError("provider", `Orange token endpoint answered ${response.status}`, response.status),
    ),
    Effect.flatMap((response) =>
      Effect.try({
        try: () => TokenResponse.parse(response.body),
        catch: () =>
          httpError("unexpected_response", "Orange token response did not match the contract"),
      }),
    ),
    Effect.map((token) => token.access_token),
  );

  return {
    id: "orange_money",

    initiate: (input: InitiateChargeInput): Effect.Effect<InitiatedCharge, PaymentProviderError> =>
      Effect.gen(function* () {
        yield* requireCredential(deps.merchantKey, "ORANGE_MERCHANT_KEY");
        yield* requireCredential(deps.clientId, "ORANGE_CLIENT_ID");
        yield* requireCredential(deps.clientSecret, "ORANGE_CLIENT_SECRET");
        yield* validateChargeInput(input);
        const token = yield* accessToken;

        const response = yield* Effect.tryPromise({
          try: () =>
            fetchJson(`${baseUrl}/orange-money-webpay/dev/v1/webpayment`, {
              method: "POST",
              headers: {
                Authorization: `Bearer ${token}`,
                "Content-Type": "application/json",
                Accept: "application/json",
                "X-AUTH": deps.merchantKey,
              },
              body: JSON.stringify({
                merchantKey: deps.merchantKey,
                currency: "XAF",
                orderId: input.referenceId,
                amount: input.amountXaf,
                reference: input.referenceId,
                // The wallet holder's MSISDN rides in `reference` metadata for
                // reconciliation; Web Payment collects the payer on statusUrl.
                msisdn: normalizeMsisdn(input.payerPhone),
                description: input.description,
                returnUrl: deps.returnUrl,
                cancelUrl: deps.cancelUrl,
                notifUrl: deps.notifUrl,
                lang: "fr",
              }),
            }),
          catch: () => httpError("provider", "Orange webpayment call failed"),
        });

        if (response.status !== 201 && response.status !== 200) {
          return yield* Effect.fail(
            httpError(
              response.status >= 400 && response.status < 500 ? "declined" : "provider",
              `Orange webpayment answered ${response.status}`,
              response.status,
            ),
          );
        }
        const decoded = yield* Effect.try({
          try: () => InitiateResponse.parse(response.body),
          catch: () =>
            httpError("unexpected_response", "Orange initiate response did not match the contract"),
        });
        if (decoded.message !== "OK") {
          return yield* Effect.fail(
            httpError("declined", `Orange refused the charge: ${decoded.message}`),
          );
        }
        return { providerChargeId: decoded.payToken, status: "pending" as const };
      }),

    status: (providerChargeId: string): Effect.Effect<ChargeStatus, PaymentProviderError> =>
      Effect.gen(function* () {
        yield* requireCredential(deps.merchantKey, "ORANGE_MERCHANT_KEY");
        const token = yield* accessToken;
        const response = yield* Effect.tryPromise({
          try: () =>
            fetchJson(
              `${baseUrl}/orange-money-webpay/dev/v1/webpayment/status/${encodeURIComponent(providerChargeId)}`,
              {
                method: "GET",
                headers: { Authorization: `Bearer ${token}`, Accept: "application/json" },
              },
            ),
          catch: () => httpError("provider", "Orange status call failed"),
        });
        if (response.status === 404) {
          return yield* Effect.fail(
            httpError("unexpected_response", `Orange knows no charge ${providerChargeId}`, 404),
          );
        }
        if (response.status !== 200) {
          // 5xx and oddballs are upstream trouble; contract violations on a
          // 2xx are unexpected_response below.
          return yield* Effect.fail(
            httpError("provider", `Orange status answered ${response.status}`, response.status),
          );
        }
        const decoded = yield* Effect.try({
          try: () => PaymentStatusResponse.parse(response.body),
          catch: () =>
            httpError("unexpected_response", "Orange status response did not match the contract"),
        });
        return toChargeStatus(decoded.status);
      }),
  };
};

/**
 * Production/sandbox adapter. Env-configured (`.env.schema`); credentials are
 * a deploy-time user action — unset creds fail per call (`not_configured`),
 * never at boot.
 */
export const OrangeMoneyProviderLive = Layer.effect(
  OrangeMoneyProvider,
  Effect.gen(function* () {
    const baseUrl = yield* Config.string("ORANGE_BASE_URL").pipe(
      Config.withDefault("https://api.orange.com"),
    );
    const clientId = yield* Config.string("ORANGE_CLIENT_ID").pipe(Config.withDefault(""));
    const clientSecret = yield* Config.string("ORANGE_CLIENT_SECRET").pipe(Config.withDefault(""));
    const merchantKey = yield* Config.string("ORANGE_MERCHANT_KEY").pipe(Config.withDefault(""));
    const returnUrl = yield* Config.string("ORANGE_RETURN_URL").pipe(Config.withDefault(""));
    const cancelUrl = yield* Config.string("ORANGE_CANCEL_URL").pipe(Config.withDefault(""));
    const notifUrl = yield* Config.string("ORANGE_NOTIF_URL").pipe(Config.withDefault(""));
    return makeOrangeMoneyProvider({
      baseUrl,
      clientId,
      clientSecret,
      merchantKey,
      returnUrl,
      cancelUrl,
      notifUrl,
      fetchJson: defaultFetchJson,
    });
  }),
);
