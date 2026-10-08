import { Data } from "effect";

/**
 * Phone-OTP domain errors (P8.T6). Tagged errors ride the Effect error channel
 * and are mapped to `(status, stable code)` in src/http/error-mapper.ts; the
 * `code` keys the localized en/fr message. Codes are API contract — renaming
 * one is a breaking change (docs/error-codes.md).
 */

/** No channel could take the message: everything unconfigured, or the
 *  configured provider failed its transport. Retryable once credentials
 *  arrive / the provider recovers (the pending registration is discarded so a
 *  retry is not blocked by the resend cooldown). */
export class OtpDeliveryUnavailable extends Data.TaggedError("OtpDeliveryUnavailable")<{
  readonly kind: "not_configured" | "provider";
}> {}

/** The per-phone / per-IP send budget for this window is spent. */
export class OtpSendThrottled extends Data.TaggedError("OtpSendThrottled")<{
  readonly scope: "phone" | "ip";
  readonly retryAfterSeconds: number;
}> {}

/** A live code exists and was sent too recently to replace it. */
export class OtpResendTooSoon extends Data.TaggedError("OtpResendTooSoon")<{
  readonly retryAfterSeconds: number;
}> {}

/** The phone is locked after too many wrong codes. */
export class OtpLocked extends Data.TaggedError("OtpLocked")<{
  readonly retryAfterSeconds: number;
}> {}

/** Wrong code. `remainingAttempts` lets the client show the budget left. */
export class OtpInvalid extends Data.TaggedError("OtpInvalid")<{
  readonly remainingAttempts: number;
}> {}

/** No live code for this phone (never sent, or the TTL passed). */
export class OtpExpired extends Data.TaggedError("OtpExpired")<{
  readonly reason: "not_found" | "ttl_elapsed";
}> {}

/** This code was already consumed — replay is rejected. */
export class OtpAlreadyUsed extends Data.TaggedError("OtpAlreadyUsed")<{}> {}

/** The phone is already a VERIFIED identity of another account (or the email
 *  for a phone-signup is taken) — one verified phone maps to one user. */
export class PhoneAlreadyVerified extends Data.TaggedError("PhoneAlreadyVerified")<{
  readonly reason: "phone_in_use";
}> {}
