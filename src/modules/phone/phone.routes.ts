import { createRoute, type OpenAPIHono } from "@hono/zod-openapi";
import { Effect } from "effect";

import type { AppEnv, AppRuntime } from "@/http/app-env";
import { makeRun } from "@/http/run";
import { ErrorResponse } from "@/http/schemas";
import { clientKey } from "@/http/client-key";
import { PhoneService, type PhoneCaller } from "./phone.service";
import {
  PhoneStartBody,
  PhoneStartResponse,
  PhoneVerifyBody,
  PhoneVerifyResponse,
} from "./phone.contract";

const jsonBody = <T>(schema: T) => ({ content: { "application/json": { schema } } });

const start = createRoute({
  method: "post",
  path: "/v1/auth/phone/start",
  tags: ["Auth"],
  summary: "Start (or re-send) phone-number verification via OTP",
  description: [
    "Register or attach a phone number and deliver a 6-digit code to it. Delivery tries the SMS",
    "channel (Twilio) first; when SMS is unconfigured it falls back to EMAIL; when no channel is",
    "configured in a non-prod environment the code is returned as `devCode` so the flow works in",
    "sandbox/dev mode (never in prod/staging).",
    "",
    "Called WITHOUT a session this is phone SIGNUP: `email`, `name` and `password` are required and",
    "the account is materialized by the verify call. Called WITH a session it ATTACHES (or changes)",
    "the signed-in user's verified phone. A phone already verified by another account is rejected",
    "(`409 PHONE_ALREADY_VERIFIED`).",
    "",
    "Throttling: per-phone and per-IP send budgets (`429 OTP_SEND_THROTTLED`) and a 60s resend",
    "cooldown per phone (`429 OTP_RESEND_COOLDOWN`). Codes live 10 minutes, are single-use, and are",
    "stored only as an HMAC (never plaintext).",
  ].join("\n"),
  request: { body: jsonBody(PhoneStartBody) },
  responses: {
    200: {
      ...jsonBody(PhoneStartResponse),
      description: "The verification was created and the code dispatched.",
    },
    409: {
      ...jsonBody(ErrorResponse),
      description:
        "`PHONE_ALREADY_VERIFIED` — the phone already belongs to another account; `CONFLICT` — the signup email is already registered.",
    },
    422: {
      ...jsonBody(ErrorResponse),
      description: "Validation failed (phone format; missing signup fields).",
    },
    429: {
      ...jsonBody(ErrorResponse),
      description:
        "`OTP_SEND_THROTTLED` — the per-phone or per-IP send budget is spent; `OTP_RESEND_COOLDOWN` — a code was sent too recently.",
    },
    503: {
      ...jsonBody(ErrorResponse),
      description:
        "`OTP_DELIVERY_UNAVAILABLE` — no delivery channel is configured (prod/staging) or the configured provider failed.",
    },
  },
});

const verify = createRoute({
  method: "post",
  path: "/v1/auth/phone/verify",
  tags: ["Auth"],
  summary: "Verify the phone OTP (creates the account on signup)",
  description: [
    "Consume the 6-digit code. On the signup path this creates the account (user + credential +",
    "verified phone identity) in one transaction; `emailVerified` tells whether the email was",
    "proven (OTP delivered by email) — otherwise complete the standard better-auth email",
    "verification before `POST /api/auth/sign-in/email`.",
    "On the attach path (signed in) the verified phone is upserted onto the caller's account.",
    "",
    "Wrong codes are capped: after 3 failures the phone locks for 15 minutes (`429 OTP_LOCKED`).",
    "Expired (`409 OTP_EXPIRED`), replayed (`409 OTP_ALREADY_USED`), or unknown codes are rejected.",
  ].join("\n"),
  request: { body: jsonBody(PhoneVerifyBody) },
  responses: {
    200: {
      ...jsonBody(PhoneVerifyResponse),
      description: "The phone is verified (and the account materialized on signup).",
    },
    401: {
      ...jsonBody(ErrorResponse),
      description: "`OTP_INVALID` — wrong code (`details` carries the remaining attempts).",
    },
    409: {
      ...jsonBody(ErrorResponse),
      description:
        "`OTP_EXPIRED` — no live code for this phone or the TTL passed; `OTP_ALREADY_USED` — replayed.",
    },
    422: { ...jsonBody(ErrorResponse), description: "Validation failed (phone/code format)." },
    429: {
      ...jsonBody(ErrorResponse),
      description: "`OTP_LOCKED` — too many wrong codes; wait for the lockout to end.",
    },
  },
});

export const registerPhoneRoutes = (app: OpenAPIHono<AppEnv>, runtime: AppRuntime): void => {
  const { run } = makeRun(runtime);

  app.openapi(start, (c) => {
    const sessionUser = c.get("user");
    const caller: PhoneCaller =
      sessionUser === null ? null : { userId: sessionUser.id, email: sessionUser.email };
    const body = c.req.valid("json");
    return run(
      Effect.gen(function* () {
        const service = yield* PhoneService;
        const view = yield* service.start({
          phoneRaw: body.phone,
          email: body.email,
          name: body.name,
          password: body.password,
          locale: body.locale,
          caller,
          ip: clientKey(c.req.header("x-forwarded-for")),
        });
        // The dev code is sandbox/dev only — the service never sets it in
        // prod/staging, so the property is omitted there rather than nulled.
        const payload =
          view.devCode === undefined
            ? {
                phone: view.phone,
                channel: view.channel,
                expiresAt: view.expiresAt.toISOString(),
                resendAfterSeconds: view.resendAfterSeconds,
              }
            : {
                phone: view.phone,
                channel: view.channel,
                expiresAt: view.expiresAt.toISOString(),
                resendAfterSeconds: view.resendAfterSeconds,
                devCode: view.devCode,
              };
        return c.json(payload, 200);
      }),
    );
  });

  app.openapi(verify, (c) => {
    const sessionUser = c.get("user");
    const caller: PhoneCaller =
      sessionUser === null ? null : { userId: sessionUser.id, email: sessionUser.email };
    const body = c.req.valid("json");
    return run(
      Effect.gen(function* () {
        const service = yield* PhoneService;
        const view = yield* service.verify({
          phoneRaw: body.phone,
          code: body.code,
          caller,
        });
        return c.json(
          {
            verified: true,
            phone: view.phone,
            emailVerified: view.emailVerified,
            nextStep: view.nextStep,
          },
          200,
        );
      }),
    );
  });
};
