import { Context, Data, Effect, Layer } from "effect";

/**
 * Mobile-money provider abstraction (P5.T1). The checkout service (P5.T3)
 * talks to THIS seam only; the MoMo Collections and Orange Money Web Payment
 * adapters behind it are sandbox-first and env-configured (merchant
 * credentials are a deploy-time user action — until set, every call fails
 * with `not_configured` instead of boot failing, so payments stay optional
 * infrastructure).
 *
 * Money is integer XAF everywhere — no floats (P5.T6).
 */

/** Which mobile-money rail a charge runs on. */
export type PaymentProviderId = "momo" | "orange_money";

export const PAYMENT_PROVIDER_IDS = ["momo", "orange_money"] as const;

/** Adapter-level charge lifecycle; the `payment` table (P5.T2) maps onto it. */
export type ChargeStatus = "pending" | "succeeded" | "failed";

/**
 * Start a charge. `referenceId` is caller-generated (our future payment id) —
 * it doubles as the provider's idempotency key (MoMo `X-Reference-Id`,
 * Orange `orderId`), so retrying with the same reference cannot double-charge.
 */
export type InitiateChargeInput = {
  readonly referenceId: string;
  readonly amountXaf: number;
  /** MSISDN of the wallet to debit, local or E.164 (adapters normalize). */
  readonly payerPhone: string;
  readonly description: string;
};

export type InitiatedCharge = {
  /** Opaque provider handle to poll — MoMo referenceId / Orange payToken. */
  readonly providerChargeId: string;
  readonly status: ChargeStatus;
};

export class PaymentProviderError extends Data.TaggedError("PaymentProviderError")<{
  /** not_configured: creds missing (user-action). invalid_request: bad input.
   *  declined: the wallet/provider refused. provider: transport/5xx trouble.
   *  unexpected_response: the provider answered outside its contract. */
  readonly kind:
    | "not_configured"
    | "invalid_request"
    | "declined"
    | "provider"
    | "unexpected_response";
  readonly message: string;
  readonly httpStatus?: number;
}> {}

export interface PaymentProviderService {
  readonly id: PaymentProviderId;
  readonly initiate: (
    input: InitiateChargeInput,
  ) => Effect.Effect<InitiatedCharge, PaymentProviderError>;
  readonly status: (providerChargeId: string) => Effect.Effect<ChargeStatus, PaymentProviderError>;
}

/**
 * Registry of all providers, keyed by rail — the checkout layer picks one per
 * user-selected method. Built from the two adapter layers; each adapter fails
 * PER CALL (not at boot) when its credentials are absent.
 */
export class PaymentProviders extends Context.Tag("PaymentProviders")<
  PaymentProviders,
  Readonly<Record<PaymentProviderId, PaymentProviderService>>
>() {}

/** Minimal HTTP seam the adapters run through — faked in contract tests. */
export type FetchJson = (
  url: string,
  init: {
    readonly method: string;
    readonly headers: Readonly<Record<string, string>>;
    readonly body?: string;
  },
) => Promise<{ readonly status: number; readonly body: unknown }>;

/** The real adapter transport: platform fetch + lenient body parse (an empty
 *  body — MoMo's 202 — and non-JSON payloads decode to null; the adapters'
 *  zod layer then rejects them as unexpected_response). */
export const defaultFetchJson: FetchJson = async (url, init) => {
  const response = await fetch(url, {
    method: init.method,
    headers: init.headers,
    body: init.body,
  });
  const body = await response.json().catch(() => null);
  return { status: response.status, body };
};

export type ProviderHttpDeps = {
  readonly baseUrl: string;
  readonly fetchJson: FetchJson;
};

/** Credentials gate shared by both adapters: fail per call, never at boot. */
export const requireCredential = (
  value: string,
  what: string,
): Effect.Effect<string, PaymentProviderError> =>
  value.trim() === ""
    ? Effect.fail(
        new PaymentProviderError({
          kind: "not_configured",
          message: `${what} is not configured (sandbox/merchant credentials are a deploy-time user action)`,
        }),
      )
    : Effect.succeed(value);

/** XAF is integer-only money — reject anything else before it reaches a provider. */
export const validateChargeInput = (
  input: InitiateChargeInput,
): Effect.Effect<InitiateChargeInput, PaymentProviderError> => {
  const issues: string[] = [];
  if (!Number.isInteger(input.amountXaf) || input.amountXaf <= 0) {
    issues.push("amountXaf must be a positive integer (XAF has no minor unit)");
  }
  if (!/^\+?\d{8,15}$/.test(input.payerPhone.replace(/[\s-]/g, ""))) {
    issues.push("payerPhone must be a valid MSISDN");
  }
  if (input.referenceId.trim() === "") {
    issues.push("referenceId must be a non-empty idempotency key");
  }
  return issues.length > 0
    ? Effect.fail(new PaymentProviderError({ kind: "invalid_request", message: issues.join("; ") }))
    : Effect.succeed(input);
};

/** Normalize a local or E.164 MSISDN to digits (providers want MSISDN form). */
export const normalizeMsisdn = (phone: string): string => {
  const digits = phone.replace(/[\s-]/g, "").replace(/^\+/, "");
  // Local Cameroon numbers (9 digits, leading 6) get the country code; E.164
  // input already carries it.
  return digits.length === 9 ? `237${digits}` : digits;
};

/** Layer that serves the registry from explicit services (used by tests + fakes). */
export const PaymentProvidersTestLive = (
  providers: Readonly<Record<PaymentProviderId, PaymentProviderService>>,
): Layer.Layer<PaymentProviders> => Layer.succeed(PaymentProviders, providers);
