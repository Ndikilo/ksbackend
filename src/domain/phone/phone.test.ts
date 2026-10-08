import { describe, expect, it } from "vitest";

import {
  deliveryChain,
  devSurfacingAllowed,
  isOtpExpired,
  lockDecision,
  maskPhone,
  OTP_LOCKOUT_MS,
  OTP_MAX_VERIFY_ATTEMPTS,
  OTP_RESEND_COOLDOWN_MS,
  OTP_TTL_MS,
  otpCodeHash,
  resendDecision,
  toE164,
  validatePhoneDigits,
  verifyFailureOutcome,
} from "./phone";

/** Fixed instant: 2026-10-07T12:00:00Z (no string parsing — epoch-built). */
const NOW: Date = (() => {
  const at = new Date(0);
  at.setUTCFullYear(2026, 9, 7);
  at.setUTCHours(12, 0, 0, 0);
  return at;
})();

describe("validatePhoneDigits (normalized E.164 digits)", () => {
  it("accepts a Cameroon mobile with country code (MoMo-normalized shape)", () => {
    expect(validatePhoneDigits("237670123456")).toEqual({ valid: true });
  });

  it("accepts other E.164 numbers (diaspora callers)", () => {
    expect(validatePhoneDigits("33612345678")).toEqual({ valid: true });
  });

  it("rejects non-digits, short, long, and 0-prefixed input", () => {
    expect(validatePhoneDigits("237abc123456").valid).toBe(false);
    expect(validatePhoneDigits("23767").valid).toBe(false);
    expect(validatePhoneDigits(`1234567890123456`)).toEqual({
      valid: false,
      reason: "E.164 subscriber numbers are 8–15 digits",
    });
    // A leading 0 means the international prefix was kept — not a country code.
    expect(validatePhoneDigits("0237670123456").valid).toBe(false);
  });

  it("rejects the empty string", () => {
    expect(validatePhoneDigits("").valid).toBe(false);
  });
});

describe("E.164 surface + masking", () => {
  it("toE164 prepends the plus", () => {
    expect(toE164("237670123456")).toBe("+237670123456");
  });

  it("maskPhone keeps the country code and last four only", () => {
    expect(maskPhone("237670123456")).toBe("+237…3456");
  });

  it("maskPhone does not slice shorter-than-4 numbers", () => {
    expect(maskPhone("1234")).toBe("+1234");
  });
});

/** A fake keyed digest (string-identical, so equality tests can pin it). */
const hmac = (value: string): string => `h(${value})`;
/** A one-way digest shape: only the input's length is visible in the output. */
const oneWay = (value: string): string => `h#${value.length}`;

describe("otpCodeHash (HMAC at rest)", () => {
  it("binds the phone into the digest — same code, different phone, different hash", () => {
    expect(otpCodeHash("237670123456", "123456", hmac)).not.toBe(
      otpCodeHash("237670123457", "123456", hmac),
    );
  });

  it("is deterministic for the same phone+code+hmac", () => {
    expect(otpCodeHash("237670123456", "123456", hmac)).toBe(
      otpCodeHash("237670123456", "123456", hmac),
    );
  });

  it("changes with the hmac function (key rotation invalidates stored codes)", () => {
    expect(otpCodeHash("237670123456", "123456", hmac)).not.toBe(
      otpCodeHash("237670123456", "123456", (v) => `other(${v})`),
    );
  });

  it("never returns the plaintext code (one-way digest, unlike a pass-through)", () => {
    // A realistic keyed digest only leaks its LENGTH, not its input.
    expect(otpCodeHash("237670123456", "123456", oneWay)).toBe("h#29");
    expect(otpCodeHash("237670123456", "123456", oneWay)).not.toContain("123456");
  });
});

describe("OTP lifecycle decisions", () => {
  it("a code expires exactly at its TTL boundary", () => {
    const expiresAt = new Date(NOW.getTime() + OTP_TTL_MS);
    expect(isOtpExpired(expiresAt, new Date(NOW.getTime() + OTP_TTL_MS - 1))).toBe(false);
    expect(isOtpExpired(expiresAt, expiresAt)).toBe(true);
  });

  it("resend cooldown: blocked inside 60s with a whole-second wait, allowed after", () => {
    const lastSentAt = NOW;
    const inside = resendDecision(lastSentAt, new Date(NOW.getTime() + OTP_RESEND_COOLDOWN_MS - 1));
    expect(inside).toEqual({ allowed: false, retryAfterSeconds: 1 });
    const midway = resendDecision(lastSentAt, new Date(NOW.getTime() + 30_000));
    expect(midway).toEqual({ allowed: false, retryAfterSeconds: 30 });
    expect(resendDecision(lastSentAt, new Date(NOW.getTime() + OTP_RESEND_COOLDOWN_MS))).toEqual({
      allowed: true,
    });
  });

  it("verify failures leave attempts until the budget is spent, then lock for 15 minutes", () => {
    const first = verifyFailureOutcome(1, NOW);
    expect(first).toEqual({ lockedUntil: null, remainingAttempts: OTP_MAX_VERIFY_ATTEMPTS - 1 });
    const last = verifyFailureOutcome(OTP_MAX_VERIFY_ATTEMPTS, NOW);
    expect(last.remainingAttempts).toBe(0);
    expect(last.lockedUntil).toEqual(new Date(NOW.getTime() + OTP_LOCKOUT_MS));
  });

  it("lockout releases exactly at the lock boundary", () => {
    const lockedUntil = new Date(NOW.getTime() + OTP_LOCKOUT_MS);
    const inside = lockDecision(lockedUntil, new Date(lockedUntil.getTime() - 1));
    expect(inside.allowed).toBe(false);
    if (!inside.allowed) expect(inside.retryAfterSeconds).toBe(1);
    expect(lockDecision(lockedUntil, lockedUntil)).toEqual({ allowed: true });
  });
});

describe("delivery fallback", () => {
  it("tries SMS first and adds email only when an address exists", () => {
    expect(deliveryChain(true)).toEqual(["sms", "email"]);
    expect(deliveryChain(false)).toEqual(["sms"]);
  });

  it("dev surfacing is allowed outside prod/staging and NEVER in them", () => {
    expect(devSurfacingAllowed("local")).toBe(true);
    expect(devSurfacingAllowed("test")).toBe(true);
    expect(devSurfacingAllowed("ci")).toBe(true);
    expect(devSurfacingAllowed("staging")).toBe(false);
    expect(devSurfacingAllowed("prod")).toBe(false);
  });
});
