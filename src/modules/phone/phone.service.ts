import { SqlClient, SqlError } from "@effect/sql";
import { Clock, Config, Context, Effect, Layer } from "effect";
import { hashPassword } from "better-auth/crypto";

import {
  OtpAlreadyUsed,
  OtpDeliveryUnavailable,
  OtpExpired,
  OtpInvalid,
  OtpLocked,
  OtpResendTooSoon,
  OtpSendThrottled,
  PhoneAlreadyVerified,
} from "@/domain/phone/errors";
import {
  deliveryChain,
  devSurfacingAllowed,
  generateOtpCode,
  isOtpExpired,
  lockDecision,
  OTP_LOCKOUT_MS,
  OTP_RESEND_COOLDOWN_MS,
  OTP_TTL_MS,
  otpCodeHash,
  resendDecision,
  toE164,
  validatePhoneDigits,
  verifyFailureOutcome,
  type OtpDeliveryChannel,
  type PhoneRegistrationPurpose,
} from "@/domain/phone/phone";
import { Conflict, ValidationFailed } from "@/domain/shared/errors";
import { Crypto, type CryptoService } from "@/infra/crypto";
import { renderEmail } from "@/infra/email-render";
import { IdGenerator, type IdGeneratorService } from "@/infra/ids";
import { translate, type Locale } from "@/infra/i18n";
import {
  NotificationChannels,
  type NotificationChannelSender,
} from "@/infra/notifications/channel";
import { normalizeMsisdn } from "@/infra/payments/provider";
import { OtpThrottle, type OtpThrottleService } from "./phone.policy";
import { PhoneRepo, type PhoneRepoService, type VerificationRow } from "./phone.repo";

/** Who is calling `start`/`verify`: a session (attach/change) or nobody (signup). */
export type PhoneCaller = { readonly userId: string; readonly email: string } | null;

export type StartInput = {
  readonly phoneRaw: string;
  /** Signup-only account fields (ignored when a session is attached). */
  readonly email?: string | undefined;
  readonly name?: string | undefined;
  readonly password?: string | undefined;
  readonly locale?: Locale | undefined;
  readonly caller: PhoneCaller;
  /** Rate-limit key of the client (its last trustworthy proxy hop). */
  readonly ip: string;
};

export type StartView = {
  readonly phone: string;
  readonly channel: OtpDeliveryChannel;
  readonly expiresAt: Date;
  readonly resendAfterSeconds: number;
  /** Sandbox/dev mode ONLY — see devSurfacingAllowed; never set in prod/staging. */
  readonly devCode?: string;
};

export type VerifyInput = {
  readonly phoneRaw: string;
  readonly code: string;
  readonly caller: PhoneCaller;
};

export type VerifyView = {
  readonly phone: string;
  readonly emailVerified: boolean;
  readonly nextStep: "sign-in" | "verify-email";
};

export type StartError =
  | ValidationFailed
  | Conflict
  | PhoneAlreadyVerified
  | OtpSendThrottled
  | OtpResendTooSoon
  | OtpDeliveryUnavailable
  | SqlError.SqlError;

export type VerifyError =
  | ValidationFailed
  | OtpExpired
  | OtpAlreadyUsed
  | OtpLocked
  | OtpInvalid
  | SqlError.SqlError;

export interface PhoneServiceService {
  /** Begin (or, after the cooldown, re-send) a phone verification. */
  readonly start: (input: StartInput) => Effect.Effect<StartView, StartError>;
  /** Consume a code; on signup this materializes the account. */
  readonly verify: (input: VerifyInput) => Effect.Effect<VerifyView, VerifyError>;
}

export class PhoneService extends Context.Tag("PhoneService")<
  PhoneService,
  PhoneServiceService
>() {}

/**
 * better-auth's own scrypt hash — the exact value its credential account rows
 * carry, so a phone-signup account signs in through `/api/auth/sign-in/email`
 * like any other. Hashing failure is a defect (500 INTERNAL), not a domain error.
 */
const hashPasswordEffect = (password: string): Effect.Effect<string> =>
  Effect.tryPromise({
    try: () => hashPassword(password),
    catch: (cause) => new Error(`password hashing failed: ${String(cause)}`),
  }).pipe(Effect.orDie);

const invalidPhone = () =>
  new ValidationFailed({
    issues: [{ path: "phone", message: "Enter a valid phone number (e.g. +237670123456)." }],
  });

/** Cameroon-centric normalization (infra/payments `normalizeMsisdn`) + E.164 validation. */
const normalizePhone = (raw: string): string | undefined => {
  const digits = normalizeMsisdn(raw);
  return validatePhoneDigits(digits).valid ? digits : undefined;
};

/**
 * The only SQL capability this service uses: one shared transaction around the
 * verify materialization. Narrow on purpose — the unit tier injects an identity
 * transaction, the Live layer passes the pooled SqlClient (a structural match).
 */
export type SqlTransactional = Pick<SqlClient.SqlClient, "withTransaction">;

export type PhoneServiceDeps = {
  readonly repo: PhoneRepoService;
  readonly ids: IdGeneratorService;
  readonly crypto: CryptoService;
  readonly channels: Readonly<Record<"sms" | "email" | "push", NotificationChannelSender>>;
  readonly throttle: OtpThrottleService;
  readonly sql: SqlTransactional;
  readonly appEnv: string;
  readonly defaultLocale: Locale;
};

/** Build the service over explicit deps — the seam the unit tier drives. */
export const makePhoneService = (deps: PhoneServiceDeps): PhoneServiceService => {
  const { repo, ids, crypto, channels, throttle, sql, appEnv, defaultLocale } = deps;

  /**
   * Walk the delivery chain (SMS first, then email when an address exists),
   * skipping channels that are merely UNCONFIGURED (the P6.T1 adapters fail
   * per call with `not_configured` until their deploy-time credentials
   * exist). A channel that IS configured but fails its transport aborts the
   * walk — silently switching rails on a provider outage would mask real
   * incidents. Returns the channel that took the message, or null when every
   * channel was unconfigured (caller decides: dev surface, or fail).
   */
  const deliver = (
    queue: ReadonlyArray<"sms" | "email">,
    message: {
      readonly smsTo: string;
      readonly emailTo: string;
      readonly code: string;
      readonly locale: Locale;
    },
  ): Effect.Effect<OtpDeliveryChannel | null, OtpDeliveryUnavailable> => {
    const [channel, ...rest] = queue;
    if (channel === undefined) return Effect.succeed(null);
    const rendered = renderEmail({ kind: "otp", otp: message.code }, message.locale);
    return channels[channel]
      .send({
        to: channel === "sms" ? message.smsTo : message.emailTo,
        title: rendered.subject,
        bodyHtml: rendered.html,
        bodyText: translate(message.locale, "otp.smsBody", { code: message.code }),
      })
      .pipe(
        Effect.as(channel),
        Effect.catchAll((error) =>
          error.kind === "not_configured"
            ? deliver(rest, message)
            : Effect.fail(new OtpDeliveryUnavailable({ kind: "provider" })),
        ),
      );
  };

  const enforceThrottle = (phone: string, ip: string): Effect.Effect<void, OtpSendThrottled> =>
    Effect.gen(function* () {
      const perPhone = yield* throttle.consumeSend("phone", phone);
      if (!perPhone.allowed) {
        return yield* Effect.fail(
          new OtpSendThrottled({ scope: "phone", retryAfterSeconds: perPhone.retryAfterSeconds }),
        );
      }
      const perIp = yield* throttle.consumeSend("ip", ip);
      if (!perIp.allowed) {
        return yield* Effect.fail(
          new OtpSendThrottled({ scope: "ip", retryAfterSeconds: perIp.retryAfterSeconds }),
        );
      }
    });

  return {
    start: (input) =>
      Effect.gen(function* () {
        const purpose: PhoneRegistrationPurpose = input.caller === null ? "signup" : "attach";
        const phone = normalizePhone(input.phoneRaw);
        if (phone === undefined) return yield* Effect.fail(invalidPhone());

        // Signup-only fields: required there, ignored for attach (the session
        // already has an account, whose email is the fallback address).
        const email = purpose === "signup" ? input.email?.trim().toLowerCase() : undefined;
        const name = purpose === "signup" ? input.name?.trim() : undefined;
        if (purpose === "signup") {
          const issues: Array<{ path: string; message: string }> = [];
          if (email === undefined || email === "") {
            issues.push({ path: "email", message: "Email is required for phone signup." });
          }
          if (name === undefined || name === "") {
            issues.push({ path: "name", message: "Name is required for phone signup." });
          }
          if (input.password === undefined || input.password.length < 8) {
            issues.push({
              path: "password",
              message: "A password of at least 8 characters is required for phone signup.",
            });
          }
          if (issues.length > 0) return yield* Effect.fail(new ValidationFailed({ issues }));
        }
        const password = input.password;

        // One verified phone maps to one user — reject a takeover early.
        const identity = yield* repo.identityForPhone(phone);
        if (identity !== undefined) {
          if (input.caller === null || identity.userId !== input.caller.userId) {
            return yield* Effect.fail(new PhoneAlreadyVerified({ reason: "phone_in_use" }));
          }
        }
        if (purpose === "signup" && email !== undefined && email !== "") {
          if (yield* repo.emailExists(email)) {
            return yield* Effect.fail(new Conflict({ resource: "Email" }));
          }
        }

        yield* enforceThrottle(phone, input.ip);

        const now = new Date(yield* Clock.currentTimeMillis);
        const live = yield* repo.findLatestVerification(phone);
        if (live !== undefined && live.consumedAt === null) {
          const cooldown = resendDecision(live.lastSentAt, now);
          if (!cooldown.allowed) {
            return yield* Effect.fail(
              new OtpResendTooSoon({ retryAfterSeconds: cooldown.retryAfterSeconds }),
            );
          }
        }

        const code = yield* generateOtpCode;
        const codeHash = otpCodeHash(phone, code, crypto.hmac);

        // Delivery FIRST, persistence second: a failed send never leaves a
        // pending row behind (which would block the retry behind the cooldown).
        const fallbackEmail = input.caller === null ? email : input.caller.email;
        const delivered = yield* deliver(deliveryChain(fallbackEmail !== undefined), {
          smsTo: toE164(phone),
          emailTo: fallbackEmail ?? "",
          code,
          locale: input.locale ?? defaultLocale,
        });
        let channel: OtpDeliveryChannel;
        if (delivered !== null) {
          channel = delivered;
        } else if (devSurfacingAllowed(appEnv)) {
          // Sandbox/dev: no channel is configured — surface the code in the
          // response so the flow still works e2e. Never reachable in
          // prod/staging (devSurfacingAllowed gates on APP_ENV).
          channel = "dev";
        } else {
          return yield* Effect.fail(new OtpDeliveryUnavailable({ kind: "not_configured" }));
        }

        const passwordHash =
          purpose === "signup" && password !== undefined
            ? yield* hashPasswordEffect(password)
            : null;
        const expiresAt = new Date(now.getTime() + OTP_TTL_MS);
        yield* repo.replaceVerification({
          id: yield* ids.next,
          phone,
          purpose,
          userId: input.caller?.userId ?? null,
          email: email ?? null,
          name: name ?? null,
          passwordHash,
          locale: input.locale ?? defaultLocale,
          codeHash,
          deliveredVia: channel,
          lastSentAt: now,
          expiresAt,
        });

        const base = {
          phone: toE164(phone),
          channel,
          expiresAt,
          resendAfterSeconds: Math.ceil(OTP_RESEND_COOLDOWN_MS / 1000),
        };
        // The code itself is ONLY surfaced in sandbox/dev mode (see above) —
        // production never receives it, whatever the channel state is.
        return channel === "dev" ? { ...base, devCode: code } : base;
      }),

    verify: (input) =>
      Effect.gen(function* () {
        const phone = normalizePhone(input.phoneRaw);
        if (phone === undefined) return yield* Effect.fail(invalidPhone());

        const row: VerificationRow | undefined = yield* repo.findLatestVerification(phone);
        if (row === undefined) return yield* Effect.fail(new OtpExpired({ reason: "not_found" }));
        const now = new Date(yield* Clock.currentTimeMillis);
        if (row.consumedAt !== null) return yield* Effect.fail(new OtpAlreadyUsed());
        if (isOtpExpired(row.expiresAt, now)) {
          return yield* Effect.fail(new OtpExpired({ reason: "ttl_elapsed" }));
        }
        if (row.lockedUntil !== null) {
          const locked = lockDecision(row.lockedUntil, now);
          if (!locked.allowed) {
            return yield* Effect.fail(
              new OtpLocked({ retryAfterSeconds: locked.retryAfterSeconds }),
            );
          }
        }
        // HMAC(phone+code) equality — the plaintext code is never stored, so a
        // DB dump cannot verify codes (and hash reuse across phones is bound
        // out by hashing the phone into the digest).
        if (otpCodeHash(phone, input.code, crypto.hmac) !== row.codeHash) {
          const attempted = row.failedAttempts + 1;
          const outcome = verifyFailureOutcome(attempted, now);
          yield* repo.recordVerifyFailure(row.id, attempted, outcome.lockedUntil, now);
          return outcome.lockedUntil === null
            ? yield* Effect.fail(new OtpInvalid({ remainingAttempts: outcome.remainingAttempts }))
            : yield* Effect.fail(
                new OtpLocked({ retryAfterSeconds: Math.ceil(OTP_LOCKOUT_MS / 1000) }),
              );
        }

        const materialize = Effect.gen(function* () {
          yield* repo.consumeVerification(row.id, now);
          if (row.purpose === "attach") {
            const caller = input.caller;
            if (caller === null || (row.userId !== null && row.userId !== caller.userId)) {
              // The pending attempt belongs to a session this caller doesn't
              // hold — consume nothing further, refuse without attachment.
              return false;
            }
            yield* repo.upsertIdentity({
              identityId: yield* ids.next,
              userId: caller.userId,
              phone,
              channel: row.deliveredVia,
              verifiedAt: now,
            });
            return true;
          }
          const email = row.email;
          const name = row.name;
          const passwordHash = row.passwordHash;
          if (email === null || name === null || passwordHash === null) {
            // A live signup attempt without account fields cannot happen
            // (start validates them) — refuse rather than defect.
            return false;
          }
          const emailVerified = row.deliveredVia === "email";
          yield* repo.materializeSignup({
            userId: yield* ids.next,
            accountId: yield* ids.next,
            email,
            name,
            passwordHash,
            locale: row.locale,
            emailVerified,
            identityId: yield* ids.next,
            phone,
            channel: row.deliveredVia,
            verifiedAt: now,
          });
          return true;
        });

        const materialized = yield* sql.withTransaction(materialize);
        if (!materialized) {
          return yield* Effect.fail(new OtpExpired({ reason: "not_found" }));
        }
        if (row.purpose === "attach") {
          // A session-bearing caller already passed email verification.
          return { phone: toE164(phone), emailVerified: true, nextStep: "sign-in" as const };
        }
        const emailVerified = row.deliveredVia === "email";
        return {
          phone: toE164(phone),
          emailVerified,
          nextStep: emailVerified ? ("sign-in" as const) : ("verify-email" as const),
        };
      }),
  };
};

export const PhoneServiceLive = Layer.effect(
  PhoneService,
  Effect.gen(function* () {
    const repo = yield* PhoneRepo;
    const ids = yield* IdGenerator;
    const crypto = yield* Crypto;
    const channels = yield* NotificationChannels;
    const throttle = yield* OtpThrottle;
    const sql = yield* SqlClient.SqlClient;
    const appEnv = yield* Config.string("APP_ENV").pipe(Config.withDefault("local"));
    const defaultLocale = yield* Config.literal(
      "en",
      "fr",
    )("DEFAULT_LOCALE").pipe(Config.withDefault("fr"));
    return makePhoneService({ repo, ids, crypto, channels, throttle, sql, appEnv, defaultLocale });
  }),
);
