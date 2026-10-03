import { Data } from "effect";

/**
 * The requested payment action is not legal from the charge's current status —
 * e.g. re-paying an already-succeeded charge, refunding a failed one. `current`
 * is the status the payment is actually in. Maps to 409 PAYMENT_STATE_INVALID.
 */
export class PaymentStateInvalid extends Data.TaggedError("PaymentStateInvalid")<{
  readonly current: string;
}> {}

/**
 * The wallet/provider refused the charge (user cancelled the prompt, insufficient
 * balance, operator rejection). The payment row is stamped `failed` with the
 * reason; the patient can retry with the same or another rail. Maps to
 * 402 PAYMENT_DECLINED.
 */
export class PaymentDeclined extends Data.TaggedError("PaymentDeclined")<{
  readonly reason: string;
}> {}

/**
 * The payment provider is unreachable, misconfigured (credentials are a
 * deploy-time user action), or answered outside its contract. Nothing was
 * decided about the money — the charge stays `initiated` and the call is
 * retryable. Maps to 503 PAYMENT_PROVIDER_UNAVAILABLE.
 */
export class PaymentProviderUnavailable extends Data.TaggedError("PaymentProviderUnavailable")<{
  readonly reason: string;
}> {}

/**
 * A webhook request carried a missing, malformed, or non-matching HMAC
 * signature. Fail-closed: the payload is NEVER processed. Maps to
 * 401 WEBHOOK_SIGNATURE_INVALID.
 */
export class WebhookSignatureInvalid extends Data.TaggedError("WebhookSignatureInvalid")<
  Record<string, never>
> {}
