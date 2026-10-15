import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { Effect, Layer } from "effect";

import { account, user } from "@/db/schema/auth";
import { phoneIdentity, phoneVerification } from "@/db/schema/phone-identity";
import {
  type OutboundMessage,
  NotificationChannels,
  NotificationDeliveryError,
} from "@/infra/notifications/channel";
import { createTestHarness, testPassword, type TestHarness } from "../support/app-harness";

// SAFETY: API tests call endpoints with known response contracts and immediately assert on those shapes.
const json = <T>(res: Response): Promise<T> => res.json() as Promise<T>;

/**
 * P8.T6 — the phone-registration endpoints against the REAL Hono app +
 * Testcontainers Postgres, with the NotificationChannels seam scripted:
 *
 * - `sms: ok`  → codes ride the SMS channel (captured here, never a real send);
 * - `off`      → the channel fails per call as `not_configured`, driving the
 *                EMAIL fallback and then the dev-code surface;
 * - APP_ENV=prod + everything off → the 503 that proves a devCode can never
 *                leak in production boot config.
 *
 * The plan is MUTABLE so one harness can walk sms → email → dev by flipping it
 * between tests. Delivery acceptance is what's recorded (the log only grows on
 * accepted sends), so "empty log" = nothing delivered.
 */

type Plan = { sms: "ok" | "off"; email: "ok" | "off" };

const makeScriptedChannels = () => {
  const plan: Plan = { sms: "ok", email: "ok" };
  const recorded: Array<{
    readonly channel: "sms" | "email";
    readonly to: string;
    readonly body: string;
  }> = [];
  const sender =
    (channel: "sms" | "email") =>
    (
      message: OutboundMessage,
    ): Effect.Effect<{ providerMessageId: string }, NotificationDeliveryError> => {
      if (plan[channel] !== "ok") {
        return Effect.fail(
          new NotificationDeliveryError({ kind: "not_configured", message: "scripted off" }),
        );
      }
      recorded.push({
        channel,
        to: message.to,
        body: channel === "email" ? message.bodyHtml : message.bodyText,
      });
      return Effect.succeed({ providerMessageId: `${channel}-${recorded.length}` });
    };
  return {
    plan,
    recorded,
    layer: Layer.succeed(NotificationChannels, {
      email: { send: sender("email") },
      push: {
        send: () =>
          Effect.fail(
            new NotificationDeliveryError({ kind: "not_configured", message: "push unused here" }),
          ),
      },
      sms: { send: sender("sms") },
    }),
  };
};

const codeFrom = (
  recorded: ReturnType<typeof makeScriptedChannels>["recorded"],
  channel: "sms" | "email",
  to: string,
): string => {
  const entry = recorded.toReversed().find((r) => r.channel === channel && r.to === to);
  const match = entry?.body.match(/(\d{6})/);
  if (match?.[1] === undefined) throw new Error(`no ${channel} code captured for ${to}`);
  return match[1];
};

const PHONE = "+237670123456";
const PHONE_DIGITS = "237670123456";
const EMAIL = "phone.signup@example.com";
const SIGNUP_PASSWORD = testPassword("phone-signup");

describe("phone registration API (P8.T6) — signup, fallback, attach", () => {
  let harness: TestHarness;
  let channels: ReturnType<typeof makeScriptedChannels>;

  beforeAll(async () => {
    channels = makeScriptedChannels();
    harness = await createTestHarness(undefined, undefined, { channels: channels.layer });
  });

  afterAll(() => harness.dispose());

  it("signup: start delivers an SMS OTP, hashed at rest", async () => {
    const res = await harness.post("/v1/auth/phone/start", {
      phone: PHONE,
      email: EMAIL,
      name: "Maman Ada",
      password: SIGNUP_PASSWORD,
      locale: "fr",
    });
    expect(res.status).toBe(200);
    const body = await json<{ phone: string; channel: string; devCode?: string }>(res);
    expect(body.phone).toBe(PHONE);
    expect(body.channel).toBe("sms");
    // The dev surface NEVER fires when a real channel took the message.
    expect(body.devCode).toBeUndefined();

    const code = codeFrom(channels.recorded, "sms", PHONE);
    const rows = await harness.db
      .select()
      .from(phoneVerification)
      .where(eq(phoneVerification.phone, PHONE_DIGITS));
    expect(rows).toHaveLength(1);
    // The code exists ONLY as an HMAC — never plaintext, in any column.
    expect(rows[0]?.codeHash).not.toContain(code);
    expect(JSON.stringify(rows[0])).not.toContain(code);
  });

  it("signup: verify consumes the code and materializes the account (single-use)", async () => {
    const code = codeFrom(channels.recorded, "sms", PHONE);
    const res = await harness.post("/v1/auth/phone/verify", { phone: PHONE, code });
    expect(res.status).toBe(200);
    const body = await json<{
      verified: boolean;
      emailVerified: boolean;
      nextStep: string;
      phone: string;
    }>(res);
    // The OTP rode SMS — the signup email is NOT proven yet.
    expect(body).toEqual({
      verified: true,
      phone: PHONE,
      emailVerified: false,
      nextStep: "verify-email",
    });

    const users = await harness.db.select().from(user).where(eq(user.email, EMAIL));
    expect(users).toHaveLength(1);
    const accounts = await harness.db
      .select()
      .from(account)
      .where(eq(account.userId, users[0]?.id ?? ""));
    // A better-auth credential account — the email sign-in path works for it.
    expect(accounts[0]?.providerId).toBe("credential");
    const identities = await harness.db
      .select()
      .from(phoneIdentity)
      .where(eq(phoneIdentity.phone, PHONE_DIGITS));
    expect(identities[0]?.userId).toBe(users[0]?.id);

    // Single-use: a replay is rejected even with the right code.
    const replay = await harness.post("/v1/auth/phone/verify", { phone: PHONE, code });
    expect(replay.status).toBe(409);
    expect((await json<{ error: { code: string } }>(replay)).error.code).toBe("OTP_ALREADY_USED");
  });

  it("signup: the account completes the standard better-auth email verification + sign-in", async () => {
    expect(
      (
        await harness.post("/api/auth/email-otp/send-verification-otp", {
          email: EMAIL,
          type: "email-verification",
        })
      ).status,
    ).toBe(200);
    expect(
      (
        await harness.post("/api/auth/email-otp/verify-email", {
          email: EMAIL,
          otp: harness.otpFor(EMAIL),
        })
      ).status,
    ).toBe(200);
    const signin = await harness.post("/api/auth/sign-in/email", {
      email: EMAIL,
      password: SIGNUP_PASSWORD,
    });
    expect(signin.status).toBe(200);
    const me = await harness.app.request("/v1/me", {
      headers: { cookie: signin.headers.get("cookie") ?? "" },
    });
    expect(me.status).toBe(200);
  });

  it("signup: wrong codes are budgeted, then the phone locks", async () => {
    const phone = "+237671111101";
    const email = "phone.lockout@example.com";
    expect(
      (
        await harness.post("/v1/auth/phone/start", {
          phone,
          email,
          name: "Lock Out",
          password: testPassword("phone-lockout"),
        })
      ).status,
    ).toBe(200);

    const firstWrong = await harness.post("/v1/auth/phone/verify", { phone, code: "000001" });
    expect(firstWrong.status).toBe(401);
    const firstBody = await json<{
      error: { code: string; details: Array<{ remainingAttempts: number }> };
    }>(firstWrong);
    expect(firstBody.error.code).toBe("OTP_INVALID");
    expect(firstBody.error.details[0]?.remainingAttempts).toBe(2);

    expect((await harness.post("/v1/auth/phone/verify", { phone, code: "000002" })).status).toBe(
      401,
    );
    const thirdWrong = await harness.post("/v1/auth/phone/verify", { phone, code: "000003" });
    expect(thirdWrong.status).toBe(429);
    expect((await json<{ error: { code: string } }>(thirdWrong)).error.code).toBe("OTP_LOCKED");
    // Even the CORRECT code is refused while locked.
    const correct = codeFrom(channels.recorded, "sms", phone);
    expect((await harness.post("/v1/auth/phone/verify", { phone, code: correct })).status).toBe(
      429,
    );
  });

  it("signup: an immediate re-send hits the cooldown", async () => {
    const phone = "+237671111102";
    expect(
      (
        await harness.post("/v1/auth/phone/start", {
          phone,
          email: "phone.cooldown@example.com",
          name: "Cool Down",
          password: testPassword("phone-cooldown"),
        })
      ).status,
    ).toBe(200);
    const res = await harness.post("/v1/auth/phone/start", {
      phone,
      email: "phone.cooldown@example.com",
      name: "Cool Down",
      password: testPassword("phone-cooldown"),
    });
    expect(res.status).toBe(429);
    expect((await json<{ error: { code: string } }>(res)).error.code).toBe("OTP_RESEND_COOLDOWN");
  });

  it("fallback: with SMS unconfigured the OTP rides EMAIL and proves the address", async () => {
    channels.plan.sms = "off";
    const phone = "+237672222201";
    const email = "phone.fallback@example.com";
    const start = await harness.post("/v1/auth/phone/start", {
      phone,
      email,
      name: "Fall Back",
      password: testPassword("phone-fallback"),
    });
    expect(start.status).toBe(200);
    const startBody = await json<{ channel: string; devCode?: string }>(start);
    expect(startBody.channel).toBe("email");
    expect(startBody.devCode).toBeUndefined();

    const code = codeFrom(channels.recorded, "email", email);
    const verify = await harness.post("/v1/auth/phone/verify", { phone, code });
    expect(verify.status).toBe(200);
    const verifyBody = await json<{ emailVerified: boolean; nextStep: string }>(verify);
    // The OTP went TO the email — its possession is proven, so sign-in is direct.
    expect(verifyBody).toMatchObject({ emailVerified: true, nextStep: "sign-in" });
    const signin = await harness.post("/api/auth/sign-in/email", {
      email,
      password: testPassword("phone-fallback"),
    });
    expect(signin.status).toBe(200);
    channels.plan.sms = "ok";
  });

  it("dev mode: with NO channel configured (local) the code is surfaced and the flow still completes", async () => {
    channels.plan.sms = "off";
    channels.plan.email = "off";
    const phone = "+237673333301";
    const email = "phone.dev@example.com";
    const start = await harness.post("/v1/auth/phone/start", {
      phone,
      email,
      name: "Dev Mode",
      password: testPassword("phone-dev"),
    });
    expect(start.status).toBe(200);
    const startBody = await json<{ channel: string; devCode: string }>(start);
    expect(startBody.channel).toBe("dev");
    expect(startBody.devCode).toMatch(/^\d{6}$/);

    const verify = await harness.post("/v1/auth/phone/verify", {
      phone,
      code: startBody.devCode,
    });
    expect(verify.status).toBe(200);
    expect((await json<{ emailVerified: boolean }>(verify)).emailVerified).toBe(false);
    channels.plan = { sms: "ok", email: "ok" };
  });

  it("attach: a signed-in user verifies a phone onto their account", async () => {
    const cookie = await harness.signUpAndVerify(
      "phone.attacher@example.com",
      testPassword("phone-attacher"),
      "Ada Attacher",
    );
    const phone = "+237674444401";
    const start = await harness.post("/v1/auth/phone/start", { phone }, cookie);
    expect(start.status).toBe(200);
    expect((await json<{ channel: string }>(start)).channel).toBe("sms");

    const code = codeFrom(channels.recorded, "sms", phone);
    const verify = await harness.post("/v1/auth/phone/verify", { phone, code }, cookie);
    expect(verify.status).toBe(200);
    expect(await json<{ verified: boolean; nextStep: string }>(verify)).toMatchObject({
      verified: true,
      nextStep: "sign-in",
    });

    const attacherId = await harness.userIdFor("phone.attacher@example.com");
    const identities = await harness.db
      .select()
      .from(phoneIdentity)
      .where(eq(phoneIdentity.phone, "237674444401"));
    expect(identities[0]?.userId).toBe(attacherId);
  });

  it("conflicts: a phone verified by another account cannot be claimed; taken emails conflict", async () => {
    // PHONE is already a verified identity (first test's signup).
    const takenPhone = await harness.post("/v1/auth/phone/start", {
      phone: PHONE,
      email: "phone.other@example.com",
      name: "Other User",
      password: testPassword("phone-other"),
    });
    expect(takenPhone.status).toBe(409);
    expect((await json<{ error: { code: string } }>(takenPhone)).error.code).toBe(
      "PHONE_ALREADY_VERIFIED",
    );

    const takenEmail = await harness.post("/v1/auth/phone/start", {
      phone: "+237675555501",
      email: EMAIL,
      name: "Dup Email",
      password: testPassword("phone-dup"),
    });
    expect(takenEmail.status).toBe(409);
    expect((await json<{ error: { code: string } }>(takenEmail)).error.code).toBe("CONFLICT");
  });

  it("validation: malformed phones and missing signup fields are 422s", async () => {
    const badPhone = await harness.post("/v1/auth/phone/start", {
      phone: "0237670123456",
      email: "phone.bad@example.com",
      name: "Bad Phone",
      password: testPassword("phone-bad"),
    });
    expect(badPhone.status).toBe(422);

    const missing = await harness.post("/v1/auth/phone/start", { phone: "+237676666601" });
    expect(missing.status).toBe(422);
    const body = await json<{ error: { code: string } }>(missing);
    expect(body.error.code).toBe("VALIDATION_FAILED");

    const badCode = await harness.post("/v1/auth/phone/verify", {
      phone: PHONE,
      code: "12345",
    });
    expect(badCode.status).toBe(422);
  });
});

describe("phone registration API (P8.T6) — IP throttle", () => {
  let harness: TestHarness;
  let channels: ReturnType<typeof makeScriptedChannels>;

  beforeAll(async () => {
    channels = makeScriptedChannels();
    harness = await createTestHarness(
      { APP_ENV: "prod", PHONE_OTP_IP_SEND_MAX: "2", PHONE_OTP_SEND_MAX: "50" },
      undefined,
      { channels: channels.layer },
    );
  });

  afterAll(() => harness.dispose());

  it("a rotating IP exhausts its send budget even across phones", async () => {
    const start = (phone: string) =>
      harness.post("/v1/auth/phone/start", {
        phone,
        email: "phone.throttle@example.com",
        name: "Ip Throttle",
        password: testPassword("phone-throttle"),
      });
    expect((await start("+237681111101")).status).toBe(200);
    expect((await start("+237681111102")).status).toBe(200);
    const third = await start("+237681111103");
    expect(third.status).toBe(429);
    const body = await json<{ error: { code: string; details: Array<{ scope: string }> } }>(third);
    expect(body.error.code).toBe("OTP_SEND_THROTTLED");
    expect(body.error.details[0]?.scope).toBe("ip");
  });
});

describe("phone registration API (P8.T6) — prod delivery gate", () => {
  // Its OWN harness: the IP-throttle suite above exhausts the shared 900s
  // budget, and a throttled request 429s BEFORE the delivery gate is reached
  // (surfaced by the first-ever real execution of this tier in CI).
  let harness: TestHarness;
  let channels: ReturnType<typeof makeScriptedChannels>;

  beforeAll(async () => {
    channels = makeScriptedChannels();
    channels.plan.sms = "off";
    channels.plan.email = "off";
    harness = await createTestHarness({ APP_ENV: "prod" }, undefined, { channels: channels.layer });
  });

  afterAll(() => harness.dispose());

  it("prod with NO channel configured is a 503 — a devCode can never leak there", async () => {
    const res = await harness.post("/v1/auth/phone/start", {
      phone: "+237682222201",
      email: "phone.prod@example.com",
      name: "Prod Gate",
      password: testPassword("phone-prod"),
    });
    expect(res.status).toBe(503);
    const body = await json<{ error: { code: string } }>(res);
    expect(body.error.code).toBe("OTP_DELIVERY_UNAVAILABLE");
    expect(JSON.stringify(body)).not.toMatch(/\d{6}/);
  });
});
