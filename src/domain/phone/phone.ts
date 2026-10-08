import { Effect, Random } from "effect";

/**
 * Phone identity domain (P8.T6): the pure logic behind phone-number
 * registration via SMS OTP. No HTTP, no DB, no provider — everything here is a
 * pure decision a service (modules/phone) can drive, so the security-relevant
 * numbers (TTL, cooldown, attempt budgets, lockout) are pinned by unit tests.
 *
 * Design notes:
 * - Phone numbers are stored NORMALIZED (E.164 without the leading `+`,
 *   e.g. `237670123456`) — the same shape MoMo expects (infra/payments
 *   `normalizeMsisdn`). The API surface speaks E.164 with `+`.
 * - OTP codes are NEVER stored plaintext: the service persists
 *   `otpCodeHash(phone, code, hmac)` — an HMAC over phone+code — and compares
 *   hashes on verify.
 * - Delivery walks a fallback CHAIN: SMS first (Twilio channel), then email
 *   (when we have an address), then a dev-only surfaced code. The chain is a
 *   pure value so the fallback policy is testable without any channel.
 */

/** A normalized phone number: E.164 digits WITHOUT the leading `+`. */
export type PhoneDigits = string;

/** How the OTP for the current attempt was (or would be) delivered. */
export type OtpDeliveryChannel = "sms" | "email" | "dev";

/** Why a phone registration exists: new-account signup, or attach to the caller. */
export type PhoneRegistrationPurpose = "signup" | "attach";

//── Security constants (pinned by unit tests — do not tune casually) ─────────

/** How long an OTP is valid: 10 minutes. */
export const OTP_TTL_MS = 10 * 60_000;
/** Minimum gap between two sends to the same phone: 60 seconds. */
export const OTP_RESEND_COOLDOWN_MS = 60_000;
/** Failed verify attempts allowed before the phone locks. */
export const OTP_MAX_VERIFY_ATTEMPTS = 3;
/** How long a phone stays locked after exhausting verify attempts. */
export const OTP_LOCKOUT_MS = 15 * 60_000;

//── Normalization & validation ────────────────────────────────────────────────

/**
 * Validate an ALREADY-NORMALIZED digit string (output of infra/payments
 * `normalizeMsisdn`, which applies the Cameroon +237 default and strips
 * separators). E.164 allows 8–15 digits after the country code; the first digit
 * cannot be 0 (that is the international prefix itself). This is identity
 * validation — stricter than the MoMo payer check, because a mistyped phone
 * here would silently deliver someone else's OTP.
 */
export const validatePhoneDigits = (
  digits: string,
): { readonly valid: true } | { readonly valid: false; readonly reason: string } => {
  if (!/^\d+$/.test(digits)) return { valid: false, reason: "digits only" };
  if (digits.length < 8 || digits.length > 15) {
    return { valid: false, reason: "E.164 subscriber numbers are 8–15 digits" };
  }
  if (digits.startsWith("0")) return { valid: false, reason: "country code must not start with 0" };
  return { valid: true };
};

/** The API surface speaks E.164 (`+237…`); storage speaks bare digits. */
export const toE164 = (digits: PhoneDigits): string => `+${digits}`;

/**
 * Mask a phone for logs/responses where the full number is unnecessary
 * (`+237670123456` → `+237…3456`). Pure so the shape is pinned by tests.
 */
export const maskPhone = (digits: PhoneDigits): string =>
  digits.length <= 4 ? toE164(digits) : `+${digits.slice(0, 3)}…${digits.slice(-4)}`;

//── OTP code generation & hashing ─────────────────────────────────────────────

/**
 * A 6-digit numeric code, zero-padded, generated through Effect `Random`
 * (deterministic under a seeded Random — no `Math.random`). 1,000,000 codes
 * with a 3-attempt budget and a 15-minute lockout keeps guessing economically
 * dead; the short TTL does the rest. Requires the `Random` service.
 */
export const generateOtpCode = Effect.gen(function* () {
  const value = yield* Random.nextIntBetween(0, 1_000_000);
  return String(value).padStart(6, "0");
});

/**
 * The at-rest representation of an OTP: an HMAC over phone+code (the phone is
 * bound in so one leaked hash table cannot be replayed against another number).
 * The `hmac` function is injected (infra Crypto) — domain stays pure.
 */
export const otpCodeHash = (
  digits: PhoneDigits,
  code: string,
  hmac: (value: string) => string,
): string => hmac(`phone-otp:${digits}:${code}`);

//── Lifecycle decisions (pure — the service persists their outcomes) ─────────

/** Whether a code is still usable at `now`. */
export const isOtpExpired = (expiresAt: Date, now: Date): boolean =>
  now.getTime() >= expiresAt.getTime();

/** Result of consulting the resend cooldown. */
export type CooldownDecision =
  | { readonly allowed: true }
  | { readonly allowed: false; readonly retryAfterSeconds: number };

/** Whether a new OTP may be sent for this phone at `now`. */
export const resendDecision = (lastSentAt: Date, now: Date): CooldownDecision => {
  const elapsed = now.getTime() - lastSentAt.getTime();
  if (elapsed >= OTP_RESEND_COOLDOWN_MS) return { allowed: true };
  return {
    allowed: false,
    retryAfterSeconds: Math.max(1, Math.ceil((OTP_RESEND_COOLDOWN_MS - elapsed) / 1000)),
  };
};

/** Outcome of recording one more failed verify attempt. */
export type VerifyFailureOutcome = {
  readonly lockedUntil: Date | null;
  readonly remainingAttempts: number;
};

/**
 * After OTP_MAX_VERIFY_ATTEMPTS failures the phone locks until
 * `now + OTP_LOCKOUT_MS`. `failedAttempts` is the count INCLUDING this one.
 */
export const verifyFailureOutcome = (failedAttempts: number, now: Date): VerifyFailureOutcome =>
  failedAttempts >= OTP_MAX_VERIFY_ATTEMPTS
    ? { lockedUntil: new Date(now.getTime() + OTP_LOCKOUT_MS), remainingAttempts: 0 }
    : { lockedUntil: null, remainingAttempts: OTP_MAX_VERIFY_ATTEMPTS - failedAttempts };

/** Whether a locked phone may be verified again yet. */
export const lockDecision = (lockedUntil: Date, now: Date): CooldownDecision => {
  if (now.getTime() >= lockedUntil.getTime()) return { allowed: true };
  return {
    allowed: false,
    retryAfterSeconds: Math.max(1, Math.ceil((lockedUntil.getTime() - now.getTime()) / 1000)),
  };
};

//── Delivery fallback ─────────────────────────────────────────────────────────

/**
 * The delivery chain for one OTP attempt: SMS first (the product intent), then
 * email ONLY when we have an address to fall back to (PLAN: "falls back to
 * email when SMS unconfigured"). The service walks the chain, skipping
 * `not_configured` channels; `dev` is not part of the chain — it is the
 * last-resort sandbox surface after every channel failed as unconfigured, and
 * only when {@link devSurfacingAllowed} says the deployment may show it.
 */
export const deliveryChain = (hasEmail: boolean): ReadonlyArray<"sms" | "email"> =>
  hasEmail ? ["sms", "email"] : ["sms"];

/**
 * Whether this deployment may surface OTP codes in API responses (sandbox/dev
 * mode). Gated on APP_ENV the same way as the labeled dev-only better-auth
 * secret (infra/auth.ts): prod and staging can NEVER leak a code, whatever a
 * misconfigured channel does — the boot config there either has real
 * credentials or fails the send.
 */
export const devSurfacingAllowed = (appEnv: string): boolean =>
  appEnv !== "prod" && appEnv !== "staging";
