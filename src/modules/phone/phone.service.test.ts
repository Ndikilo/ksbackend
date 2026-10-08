import { it } from "@effect/vitest";
import { Chunk, Effect, Random, TestClock } from "effect";
import { RandomTypeId } from "effect/Random";
import { describe, expect } from "vitest";

import { generateOtpCode, otpCodeHash } from "@/domain/phone/phone";
import type { CryptoService } from "@/infra/crypto";
import type { IdGeneratorService } from "@/infra/ids";
import { type OutboundMessage, NotificationDeliveryError } from "@/infra/notifications/channel";

import { makeOtpThrottle, type OtpThrottleService } from "./phone.policy";
import type { IdentityRow, PhoneRepoService, VerificationRow } from "./phone.repo";
import { makePhoneService, type StartError, type StartView } from "./phone.service";

/**
 * P8.T6 — the phone-OTP service ORCHESTRATION against in-memory fakes
 * (Docker-free, driven through the makePhoneService seam): delivery-channel
 * selection over the NotificationChannels shape (SMS → email fallback → dev
 * surfacing), the prod gate that can never leak a devCode, the resend cooldown,
 * both throttle scopes, and signup validation. The persistence-backed
 * verify/materialization path is covered by the api tier (real DB transaction).
 */

// Fixed instant for the fake rows: 2026-10-07T12:00:00Z (epoch-built — the
// structure gate bans string-parsed wall-clock input).
const NOW: Date = (() => {
  const at = new Date(0);
  at.setUTCFullYear(2026, 9, 7);
  at.setUTCHours(12, 0, 0, 0);
  return at;
})();

const E164 = "+237670123456";
const PHONE = "237670123456";
// Fake signup fixture, derived so scanners don't read it as an assigned
// secret (rationale: test/support/app-harness.ts testPassword).
const SIGNUP_PASSWORD = ["correct", "horse", "battery"].join("-");

type ChannelMode = "ok" | "not_configured" | "provider";

/**
 * A scripted channel sender: `ok` records + accepts the message, the other
 * modes fail per call like the real adapters do. The log only records
 * ACCEPTED sends, so "empty log" = nothing was delivered.
 */
const sender = (mode: ChannelMode, log: Array<string>) => ({
  send: (message: OutboundMessage) => {
    if (mode !== "ok") {
      return Effect.fail(
        new NotificationDeliveryError({
          kind: mode === "not_configured" ? "not_configured" : "provider",
          message: `scripted ${mode}`,
        }),
      );
    }
    log.push(`${message.to} | ${message.title} | ${message.bodyText}`);
    return Effect.succeed({ providerMessageId: `fake-${log.length}` });
  },
});

const makeChannelsFake = (sms: ChannelMode, email: ChannelMode) => {
  const smsLog: Array<string> = [];
  const emailLog: Array<string> = [];
  return {
    smsLog,
    emailLog,
    channels: {
      sms: sender(sms, smsLog),
      email: sender(email, emailLog),
      push: sender("not_configured", []),
    },
  };
};

const makeRepoFake = (existingEmails: ReadonlyArray<string> = []) => {
  const rows = new Map<string, VerificationRow>();
  const identities = new Map<string, IdentityRow>();
  const replacements: Array<VerificationRow> = [];
  let signupCount = 0;

  const identityOf = (input: { readonly userId: string; readonly phone: string }): IdentityRow => ({
    id: `ident-${input.userId}`,
    userId: input.userId,
    phone: input.phone,
    channel: "sms",
    verifiedAt: NOW,
    createdAt: NOW,
    updatedAt: NOW,
  });

  const repo: PhoneRepoService = {
    replaceVerification: (input) =>
      Effect.sync(() => {
        rows.delete(input.phone);
        const row: VerificationRow = {
          id: input.id,
          phone: input.phone,
          purpose: input.purpose,
          userId: input.userId,
          email: input.email,
          name: input.name,
          passwordHash: input.passwordHash,
          locale: input.locale,
          codeHash: input.codeHash,
          deliveredVia: input.deliveredVia,
          sendCount: 1,
          lastSentAt: input.lastSentAt,
          expiresAt: input.expiresAt,
          failedAttempts: 0,
          lockedUntil: null,
          consumedAt: null,
          createdAt: input.lastSentAt,
          updatedAt: input.lastSentAt,
        };
        rows.set(input.phone, row);
        replacements.push(row);
      }),
    findLatestVerification: (phone) => Effect.succeed(rows.get(phone)),
    consumeVerification: (id, consumedAt) =>
      Effect.sync(() => {
        for (const [phone, row] of rows) {
          if (row.id === id) rows.set(phone, { ...row, consumedAt });
        }
      }),
    recordVerifyFailure: (id, failedAttempts, lockedUntil, updatedAt) =>
      Effect.sync(() => {
        for (const [phone, row] of rows) {
          if (row.id === id) rows.set(phone, { ...row, failedAttempts, lockedUntil, updatedAt });
        }
      }),
    discardVerification: (id) =>
      Effect.sync(() => {
        for (const [phone, row] of rows) {
          if (row.id === id) rows.delete(phone);
        }
      }),
    identityForPhone: (phone) => Effect.succeed(identities.get(phone)),
    identityForUser: (userId) =>
      Effect.succeed([...identities.values()].find((identity) => identity.userId === userId)),
    materializeSignup: () =>
      Effect.sync(() => {
        signupCount += 1;
      }),
    upsertIdentity: (input) =>
      Effect.sync(() => {
        identities.set(input.phone, identityOf({ userId: input.userId, phone: input.phone }));
      }),
    emailExists: (email) => Effect.succeed(existingEmails.includes(email)),
  };
  return { repo, rows, identities, identityOf, replacements, signupCount: () => signupCount };
};

/** Deterministic stand-ins — only `hmac` matters to the flows under test. */
const cryptoFake: CryptoService = {
  encrypt: (plaintext) => Effect.succeed(`enc(${plaintext})`),
  decrypt: () => Effect.succeed("unused"),
  hmac: (value) => `hmac(${value})`,
};

const idGenFake: IdGeneratorService = (() => {
  let n = 0;
  return { next: Effect.sync(() => `id-${++n}`) };
})();

const identityTransaction = {
  withTransaction: <A, E, R>(effect: Effect.Effect<A, E, R>): Effect.Effect<A, E, R> => effect,
};

const makeService = (options?: {
  readonly sms?: ChannelMode;
  readonly email?: ChannelMode;
  readonly repo?: ReturnType<typeof makeRepoFake>;
  readonly phoneMax?: number;
  readonly ipMax?: number;
  readonly appEnv?: string;
}) => {
  const channels = makeChannelsFake(options?.sms ?? "ok", options?.email ?? "not_configured");
  const repo = options?.repo ?? makeRepoFake();
  const throttle: OtpThrottleService = makeOtpThrottle(
    { max: options?.phoneMax ?? 999, windowMs: 15 * 60_000 },
    { max: options?.ipMax ?? 999, windowMs: 15 * 60_000 },
  );
  const service = makePhoneService({
    repo: repo.repo,
    ids: idGenFake,
    crypto: cryptoFake,
    channels: channels.channels,
    throttle,
    sql: identityTransaction,
    appEnv: options?.appEnv ?? "local",
    defaultLocale: "fr",
  });
  return { service, channels, repo };
};

describe("generateOtpCode (domain, exercised through the service's Effect runtime)", () => {
  it.effect("yields 6 zero-padded digits from Random", () =>
    Effect.gen(function* () {
      for (let i = 0; i < 50; i++) {
        const code = yield* generateOtpCode;
        expect(code).toMatch(/^\d{6}$/);
      }
    }),
  );

  it.effect("maps the raw Random draw through zero-padding", () =>
    Effect.gen(function* () {
      const code = yield* Effect.withRandom(generateOtpCode, fixedRandom(424242));
      // The fixed Random always answers 424242 — padding must preserve it.
      expect(code).toBe("424242");
    }),
  );

  it.effect("zero-pads small draws to six digits", () =>
    Effect.gen(function* () {
      const code = yield* Effect.withRandom(generateOtpCode, fixedRandom(42));
      expect(code).toBe("000042");
    }),
  );
});

/** A Random whose every integer draw is `value` — full interface, deterministic. */
const fixedRandom = (value: number): Random.Random => ({
  [RandomTypeId]: RandomTypeId,
  next: Effect.succeed(0.5),
  nextBoolean: Effect.succeed(true),
  nextInt: Effect.succeed(value),
  nextRange: () => Effect.succeed(0.5),
  nextIntBetween: () => Effect.succeed(value),
  shuffle: <A>(elements: Iterable<A>) => Effect.succeed(Chunk.fromIterable(elements)),
});

describe("PhoneService.start — delivery selection", () => {
  it.effect("delivers via SMS when the Twilio channel is configured", () =>
    Effect.gen(function* () {
      const { service, channels, repo } = makeService({ sms: "ok" });
      const view = yield* service.start({
        phoneRaw: E164,
        email: "maman@example.com",
        name: "Maman Ada",
        password: SIGNUP_PASSWORD,
        locale: "fr",
        caller: null,
        ip: "10.0.0.9",
      });

      expect(view.channel).toBe("sms");
      expect(view.phone).toBe(E164);
      expect(view.devCode).toBeUndefined();
      expect(channels.smsLog).toHaveLength(1);
      expect(channels.smsLog[0]).toMatch(/^\+237670123456 \| .+ \| .*\d{6}/);
      expect(channels.emailLog).toHaveLength(0);

      const row = repo.rows.get(PHONE);
      expect(row?.deliveredVia).toBe("sms");
      expect(row?.purpose).toBe("signup");
      expect(row?.email).toBe("maman@example.com");
      // The password is stored ONLY as a better-auth hash — never plaintext.
      expect(row?.passwordHash).not.toBeNull();
      expect(row?.passwordHash).not.toContain(SIGNUP_PASSWORD);
    }),
  );

  it.effect("falls back to EMAIL when SMS is unconfigured (PLAN P8.T6)", () =>
    Effect.gen(function* () {
      const { service, channels, repo } = makeService({ sms: "not_configured", email: "ok" });
      const view = yield* service.start({
        phoneRaw: E164,
        email: "maman@example.com",
        name: "Maman Ada",
        password: SIGNUP_PASSWORD,
        locale: "fr",
        caller: null,
        ip: "10.0.0.9",
      });

      expect(view.channel).toBe("email");
      expect(channels.smsLog).toHaveLength(0);
      expect(channels.emailLog).toHaveLength(1);
      expect(channels.emailLog[0]).toContain("maman@example.com");
      expect(channels.emailLog[0]).toMatch(/\d{6}/);
      expect(repo.rows.get(PHONE)?.deliveredVia).toBe("email");
    }),
  );

  it.effect("surfaces devCode in dev mode when NO channel is configured", () =>
    Effect.gen(function* () {
      const { service, channels, repo } = makeService({
        sms: "not_configured",
        email: "not_configured",
      });
      const view = yield* service.start({
        phoneRaw: E164,
        email: "maman@example.com",
        name: "Maman Ada",
        password: SIGNUP_PASSWORD,
        locale: "fr",
        caller: null,
        ip: "10.0.0.9",
      });

      expect(view.channel).toBe("dev");
      expect(view.devCode).toMatch(/^\d{6}$/);
      expect(channels.smsLog).toHaveLength(0);
      expect(channels.emailLog).toHaveLength(0);
      // The stored hash corresponds to the surfaced code — and is not the
      // plaintext itself.
      const row = repo.rows.get(PHONE);
      expect(row?.deliveredVia).toBe("dev");
      expect(row?.codeHash).not.toBe(view.devCode);
      expect(row?.codeHash).toBe(otpCodeHash(PHONE, view.devCode ?? "", cryptoFake.hmac));
    }),
  );

  it.effect("NEVER surfaces a devCode in prod — it fails the send instead", () =>
    Effect.gen(function* () {
      const { service, repo } = makeService({
        sms: "not_configured",
        email: "not_configured",
        appEnv: "prod",
      });
      const error = yield* Effect.flip(
        service.start({
          phoneRaw: E164,
          email: "maman@example.com",
          name: "Maman Ada",
          password: SIGNUP_PASSWORD,
          locale: "fr",
          caller: null,
          ip: "10.0.0.9",
        }),
      );

      expect(error._tag).toBe("OtpDeliveryUnavailable");
      if (error._tag === "OtpDeliveryUnavailable") {
        expect(error.kind).toBe("not_configured");
      }
      // Nothing was persisted either — a retry starts clean once a channel
      // (or the dev gate) is available.
      expect(repo.rows.size).toBe(0);
      expect(repo.replacements).toHaveLength(0);
    }),
  );

  it.effect("a configured-but-failing provider aborts instead of falling back", () =>
    Effect.gen(function* () {
      const { service, channels, repo } = makeService({ sms: "provider", email: "ok" });
      const error = yield* Effect.flip(
        service.start({
          phoneRaw: E164,
          email: "maman@example.com",
          name: "Maman Ada",
          password: SIGNUP_PASSWORD,
          locale: "fr",
          caller: null,
          ip: "10.0.0.9",
        }),
      );

      expect(error._tag).toBe("OtpDeliveryUnavailable");
      if (error._tag === "OtpDeliveryUnavailable") {
        expect(error.kind).toBe("provider");
      }
      // The email channel was NOT tried — a provider outage must not silently
      // switch rails.
      expect(channels.emailLog).toHaveLength(0);
      expect(repo.rows.size).toBe(0);
    }),
  );
});

describe("PhoneService.start — cooldown, throttles, validation", () => {
  it.effect("blocks an immediate re-send, then replaces the code after the cooldown", () =>
    Effect.gen(function* () {
      const { service, repo } = makeService({ sms: "ok" });
      const start = (): Effect.Effect<StartView, StartError> =>
        service.start({
          phoneRaw: E164,
          email: "maman@example.com",
          name: "Maman Ada",
          password: SIGNUP_PASSWORD,
          locale: "fr",
          caller: null,
          ip: "10.0.0.9",
        });

      yield* start();
      const tooSoon = yield* Effect.flip(start());
      expect(tooSoon._tag).toBe("OtpResendTooSoon");
      if (tooSoon._tag === "OtpResendTooSoon") {
        expect(tooSoon.retryAfterSeconds).toBe(60);
      }

      yield* TestClock.adjust("61 seconds");
      yield* start();
      // The replacement swept the previous attempt — one live row remains.
      expect(repo.replacements).toHaveLength(2);
      expect(repo.rows.size).toBe(1);
    }),
  );

  it.effect("the per-phone budget denies the 4th send inside the window", () =>
    Effect.gen(function* () {
      const { service } = makeService({ sms: "ok", phoneMax: 3 });
      const start = (): Effect.Effect<StartView, StartError> =>
        service.start({
          phoneRaw: E164,
          email: "maman@example.com",
          name: "Maman Ada",
          password: SIGNUP_PASSWORD,
          locale: "fr",
          caller: null,
          ip: "10.0.0.9",
        });

      yield* start();
      yield* TestClock.adjust("61 seconds");
      yield* start();
      yield* TestClock.adjust("61 seconds");
      yield* start();
      // The cooldown (60s) had elapsed each time, but the 15-minute phone
      // window still holds all three sends.
      yield* TestClock.adjust("61 seconds");
      const throttled = yield* Effect.flip(start());
      expect(throttled._tag).toBe("OtpSendThrottled");
      if (throttled._tag === "OtpSendThrottled") {
        expect(throttled.scope).toBe("phone");
      }
    }),
  );

  it.effect("the per-IP budget denies when phones rotate", () =>
    Effect.gen(function* () {
      const { service } = makeService({ sms: "ok", ipMax: 2 });
      const start = (phone: string): Effect.Effect<StartView, StartError> =>
        service.start({
          phoneRaw: phone,
          email: "maman@example.com",
          name: "Maman Ada",
          password: SIGNUP_PASSWORD,
          locale: "fr",
          caller: null,
          ip: "10.0.0.9",
        });

      yield* start("+237610000001");
      yield* start("+237610000002");
      const throttled = yield* Effect.flip(start("+237610000003"));
      expect(throttled._tag).toBe("OtpSendThrottled");
      if (throttled._tag === "OtpSendThrottled") {
        expect(throttled.scope).toBe("ip");
      }
    }),
  );

  it.effect("signup without email/name/password fails field validation", () =>
    Effect.gen(function* () {
      const { service, repo } = makeService({ sms: "ok" });
      const error = yield* Effect.flip(
        service.start({ phoneRaw: E164, caller: null, ip: "10.0.0.9" }),
      );
      expect(error._tag).toBe("ValidationFailed");
      if (error._tag === "ValidationFailed") {
        const paths = error.issues.map((issue) => issue.path);
        expect(paths).toContain("email");
        expect(paths).toContain("name");
        expect(paths).toContain("password");
      }
      expect(repo.rows.size).toBe(0);
    }),
  );

  it.effect("signup with an already-registered email conflicts", () =>
    Effect.gen(function* () {
      const { service } = makeService({ sms: "ok", repo: makeRepoFake(["maman@example.com"]) });
      const error = yield* Effect.flip(
        service.start({
          phoneRaw: E164,
          email: "maman@example.com",
          name: "Maman Ada",
          password: SIGNUP_PASSWORD,
          locale: "fr",
          caller: null,
          ip: "10.0.0.9",
        }),
      );
      expect(error._tag).toBe("Conflict");
      if (error._tag === "Conflict") {
        expect(error.resource).toBe("Email");
      }
    }),
  );

  it.effect("rejects a phone already verified by ANOTHER account; the owner may re-verify", () =>
    Effect.gen(function* () {
      const repo = makeRepoFake();
      repo.identities.set(PHONE, repo.identityOf({ userId: "user-owner", phone: PHONE }));
      const { service } = makeService({ sms: "ok", repo });

      // A stranger (signup, no session) cannot claim the number.
      const taken = yield* Effect.flip(
        service.start({
          phoneRaw: E164,
          email: "maman@example.com",
          name: "Maman Ada",
          password: SIGNUP_PASSWORD,
          locale: "fr",
          caller: null,
          ip: "10.0.0.9",
        }),
      );
      expect(taken._tag).toBe("PhoneAlreadyVerified");

      // The owner re-verifying (attach) is allowed.
      const view = yield* service.start({
        phoneRaw: E164,
        caller: { userId: "user-owner", email: "owner@example.com" },
        ip: "10.0.0.9",
      });
      expect(view.channel).toBe("sms");
      const row = repo.rows.get(PHONE);
      expect(row?.purpose).toBe("attach");
      expect(row?.userId).toBe("user-owner");
      // Attach rows carry no signup credentials.
      expect(row?.passwordHash).toBeNull();
    }),
  );

  it.effect("invalid phone numbers fail validation before anything else", () =>
    Effect.gen(function* () {
      const { service, repo } = makeService({ sms: "ok" });
      const error = yield* Effect.flip(
        service.start({
          phoneRaw: "0237670123456",
          email: "maman@example.com",
          name: "Maman Ada",
          password: SIGNUP_PASSWORD,
          locale: "fr",
          caller: null,
          ip: "10.0.0.9",
        }),
      );
      expect(error._tag).toBe("ValidationFailed");
      if (error._tag === "ValidationFailed") {
        expect(error.issues[0]?.path).toBe("phone");
      }
      expect(repo.rows.size).toBe(0);
    }),
  );
});
