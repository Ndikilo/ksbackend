import { Config, Context, Effect, Layer } from "effect";
import { z } from "zod";

import {
  type ChannelHttpDeps,
  type NotificationChannelSender,
  NotificationDeliveryError,
  defaultFetchJson,
} from "./channel";

/**
 * Expo push adapter (P6.T1) — the documented push API
 * (https://docs.expo.dev/push-notifications/sending-notifications/):
 *
 *   POST {baseUrl}/--/api/v2/push/send
 *   [{ to, title, body, ... }] → { data: [{ status: "ok", id } |
 *                                       { status: "error", message }] }
 *
 * `EXPO_ACCESS_TOKEN` is optional (the public API works without it for
 * modest volumes); when set it rides as a Bearer token. Device push tokens
 * reach us from the app (registration flow) — this adapter only DELIVERS.
 */

export class ExpoPushChannel extends Context.Tag("ExpoPushChannel")<
  ExpoPushChannel,
  NotificationChannelSender
>() {}

/** The per-message ticket — Expo answers one ticket per sent message. */
const Ticket = z.object({
  status: z.enum(["ok", "error"]),
  id: z.string().min(1).optional(),
  message: z.string().min(1).optional(),
});

const TicketsResponse = z.object({ data: z.array(Ticket).min(1) });

const httpError = (
  kind: NotificationDeliveryError["kind"],
  message: string,
  httpStatus?: number,
): NotificationDeliveryError =>
  httpStatus === undefined
    ? new NotificationDeliveryError({ kind, message })
    : new NotificationDeliveryError({ kind, message, httpStatus });

export const makeExpoPushSender = (
  deps: ChannelHttpDeps & { readonly accessToken: string },
): NotificationChannelSender => {
  const { baseUrl, fetchJson } = deps;

  const send: NotificationChannelSender["send"] = (message) =>
    Effect.gen(function* () {
      // An Expo push token is the contract's `to` — validate the shape the API
      // expects so a bad row fails invalid_request without a round-trip.
      if (!message.to.startsWith("ExpoPushToken[")) {
        return yield* Effect.fail(
          httpError("invalid_request", `not an Expo push token: ${message.to}`),
        );
      }
      const headers =
        deps.accessToken === ""
          ? { "content-type": "application/json" }
          : {
              "content-type": "application/json",
              Authorization: `Bearer ${deps.accessToken}`,
            };
      const response = yield* Effect.tryPromise({
        try: () =>
          fetchJson(`${baseUrl}/--/api/v2/push/send`, {
            method: "POST",
            headers,
            body: JSON.stringify({
              to: message.to,
              title: message.title,
              body: message.bodyText,
            }),
          }),
        catch: () => httpError("provider", "Expo push request failed"),
      });
      if (response.status < 200 || response.status >= 300) {
        return yield* Effect.fail(
          httpError("provider", `Expo push answered ${response.status}`, response.status),
        );
      }
      const parsed = yield* Effect.try({
        try: () => TicketsResponse.parse(response.body),
        catch: () =>
          httpError("unexpected_response", "Expo push response did not match the contract"),
      });
      const ticket = parsed.data[0];
      if (ticket === undefined || ticket.status === "error" || ticket.id === undefined) {
        return yield* Effect.fail(
          httpError(
            "invalid_request",
            ticket?.message ?? "Expo push ticket reported an error without a message",
          ),
        );
      }
      return { providerMessageId: ticket.id };
    });

  return { send };
};

export const ExpoPushChannelLive = Layer.effect(
  ExpoPushChannel,
  Effect.gen(function* () {
    const baseUrl = yield* Config.string("EXPO_PUSH_BASE_URL").pipe(
      Config.withDefault("https://exp.host"),
    );
    const accessToken = yield* Config.string("EXPO_ACCESS_TOKEN").pipe(Config.withDefault(""));
    return makeExpoPushSender({ baseUrl, accessToken, fetchJson: defaultFetchJson });
  }),
);
