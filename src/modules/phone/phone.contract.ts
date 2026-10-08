import { z } from "@hono/zod-openapi";

/**
 * Phone-registration contract (P8.T6). Two unauthenticated-friendly endpoints:
 * `POST /v1/auth/phone/start` begins (or re-sends) a verification, and
 * `POST /v1/auth/phone/verify` consumes the code. When called WITHOUT a
 * session they are the phone SIGNUP path — email/name/password are required
 * and the account is materialized on verify; with a session they ATTACH (or
 * change) the caller's verified phone.
 */

const phone = z.string().min(8).max(20).openapi({
  description:
    "Phone number in E.164 (`+237670123456`) or local Cameroon form (`670123456` — normalized to +237).",
  example: "+237670123456",
});

const code = z
  .string()
  .regex(/^\d{6}$/)
  .openapi({
    description: "The 6-digit OTP code that was delivered to the user.",
    example: "482913",
  });

export const PhoneStartBody = z
  .object({
    phone,
    email: z.email().openapi({
      description:
        "REQUIRED for phone SIGNUP (no session): the account's email — the OTP falls back here when SMS is unconfigured. Ignored when a session is attached (the account email is used).",
      example: "maman@example.com",
    }),
    name: z.string().min(1).max(120).openapi({
      description: "REQUIRED for phone SIGNUP: the account display name.",
      example: "Maman Ada",
    }),
    password: z.string().min(8).max(72).openapi({
      description:
        "REQUIRED for phone SIGNUP: the account password (hashed with better-auth's scheme; only the hash is ever stored).",
      example: "correct-horse-battery",
    }),
    locale: z.enum(["en", "fr"]).optional().openapi({
      description: "Account + message locale for signup (default: the app default).",
      example: "fr",
    }),
  })
  .openapi("PhoneStartRequest");

export const PhoneVerifyBody = z.object({ phone, code }).openapi("PhoneVerifyRequest");

export const PhoneStartResponse = z
  .object({
    phone: z.string().openapi({
      description: "The normalized E.164 phone the code was addressed to.",
      example: "+237670123456",
    }),
    channel: z.enum(["sms", "email", "dev"]).openapi({
      description:
        "How the code was delivered: `sms` (Twilio), `email` (fallback — SMS unconfigured), or `dev` (sandbox/dev mode only: no channel is configured and APP_ENV is not prod/staging).",
      example: "sms",
    }),
    expiresAt: z.string().openapi({
      description: "When the code stops being valid (ISO-8601).",
      example: "2026-10-07T12:10:00.000Z",
    }),
    resendAfterSeconds: z.number().int().openapi({
      description: "Minimum seconds before another code can be requested for this phone.",
      example: 60,
    }),
    devCode: z.string().optional().openapi({
      description:
        "DEVELOPMENT ONLY. The 6-digit code itself — present exclusively when no delivery channel is configured AND APP_ENV is neither prod nor staging. Always absent in production.",
      example: "482913",
    }),
  })
  .openapi("PhoneStartResponse");

export const PhoneVerifyResponse = z
  .object({
    verified: z.literal(true).openapi({ description: "The phone is now a verified identity." }),
    phone: z.string().openapi({
      description: "The normalized E.164 phone that was verified.",
      example: "+237670123456",
    }),
    emailVerified: z.boolean().openapi({
      description:
        "Whether the signup email is already verified (true when the OTP was delivered BY email — possession proven). Phone-signup users whose code went via SMS/dev complete the standard better-auth email verification before signing in.",
      example: false,
    }),
    nextStep: z.enum(["sign-in", "verify-email"]).openapi({
      description:
        "`sign-in` — the account can sign in right away (`POST /api/auth/sign-in/email`). `verify-email` — request the email OTP (`POST /api/auth/email-otp/send-verification-otp`) then `POST /api/auth/email-otp/verify-email` first.",
      example: "verify-email",
    }),
  })
  .openapi("PhoneVerifyResponse");
