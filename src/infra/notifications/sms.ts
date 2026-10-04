import { Config, Context, Effect, Layer } from "effect";
import { z } from "zod";

import {
  type ChannelHttpDeps,
  type NotificationChannelSender,
  NotificationDeliveryError,
  defaultFetchJson,
  requireCredential,
} from "./channel";

/**
 * SMS adapter (P6.T1) — Twilio's Messages REST API (documented, stable):
 *
 *   POST {baseUrl}/2010-04-01/Accounts/{accountSid}/Messages.json
 *   Basic accountSid:authToken, form-encoded To / From / Body
 *   → 201 { sid, status, ... }
 *
 * The provider credentials are a deploy-time user action (TWILIO_ACCOUNT_SID /
 * TWILIO_AUTH_TOKEN / TWILIO_FROM_NUMBER): until set, every send fails per
 * call with `not_configured` and boot stays green — the outbox retries on the
 * normal backoff once credentials arrive.
 */

export class SmsChannel extends Context.Tag("SmsChannel")<
  SmsChannel,
  NotificationChannelSender
>() {}

const MessageResponse = z.object({ sid: z.string().min(1) });

const httpError = (
  kind: NotificationDeliveryError["kind"],
  message: string,
  httpStatus?: number,
): NotificationDeliveryError =>
  httpStatus === undefined
    ? new NotificationDeliveryError({ kind, message })
    : new NotificationDeliveryError({ kind, message, httpStatus });

export const makeSmsSender = (
  deps: ChannelHttpDeps & {
    readonly accountSid: string;
    readonly authToken: string;
    readonly fromNumber: string;
  },
): NotificationChannelSender => {
  const { baseUrl, fetchJson } = deps;

  const send: NotificationChannelSender["send"] = (message) =>
    Effect.gen(function* () {
      const accountSid = yield* requireCredential(deps.accountSid, "TWILIO_ACCOUNT_SID");
      const authToken = yield* requireCredential(deps.authToken, "TWILIO_AUTH_TOKEN");
      const fromNumber = yield* requireCredential(deps.fromNumber, "TWILIO_FROM_NUMBER");
      if (message.bodyText.trim() === "") {
        return yield* Effect.fail(httpError("invalid_request", "SMS body must not be empty"));
      }
      // Twilio's Messages endpoint takes form-encoded fields, not JSON.
      const body = new URLSearchParams({
        To: message.to,
        From: fromNumber,
        Body: message.bodyText,
      }).toString();
      const response = yield* Effect.tryPromise({
        try: () =>
          fetchJson(`${baseUrl}/2010-04-01/Accounts/${accountSid}/Messages.json`, {
            method: "POST",
            headers: {
              Authorization: `Basic ${btoa(`${accountSid}:${authToken}`)}`,
              "content-type": "application/x-www-form-urlencoded",
            },
            body,
          }),
        catch: () => httpError("provider", "Twilio SMS request failed"),
      });
      if (response.status < 200 || response.status >= 300) {
        return yield* Effect.fail(
          httpError("provider", `Twilio answered ${response.status}`, response.status),
        );
      }
      const parsed = yield* Effect.try({
        try: () => MessageResponse.parse(response.body),
        catch: () => httpError("unexpected_response", "Twilio response did not match the contract"),
      });
      return { providerMessageId: parsed.sid };
    });

  return { send };
};

export const SmsChannelLive = Layer.effect(
  SmsChannel,
  Effect.gen(function* () {
    const baseUrl = yield* Config.string("TWILIO_BASE_URL").pipe(
      Config.withDefault("https://api.twilio.com"),
    );
    const accountSid = yield* Config.string("TWILIO_ACCOUNT_SID").pipe(Config.withDefault(""));
    const authToken = yield* Config.string("TWILIO_AUTH_TOKEN").pipe(Config.withDefault(""));
    const fromNumber = yield* Config.string("TWILIO_FROM_NUMBER").pipe(Config.withDefault(""));
    return makeSmsSender({
      baseUrl,
      accountSid,
      authToken,
      fromNumber,
      fetchJson: defaultFetchJson,
    });
  }),
);
