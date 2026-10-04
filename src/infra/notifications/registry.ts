import { Effect, Layer } from "effect";

import { EmailSender, EmailSenderResendLive } from "@/infra/email";

import { NotificationChannels, NotificationDeliveryError } from "./channel";
import { ExpoPushChannel, ExpoPushChannelLive } from "./expo-push";
import { SmsChannel, SmsChannelLive } from "./sms";

/**
 * Channel registry assembly (P6.T1): all three channels served under the
 * `NotificationChannels` tag the outbox drain dispatches on. The email entry
 * ADAPTS the existing Resend-backed `EmailSender` (infra/email.ts) to the
 * channel interface — one Resend account, one configuration surface (the
 * console fallback when RESEND_API_KEY is unset flows through unchanged).
 * Expo push and SMS are env-configured adapters that fail PER CALL without
 * credentials, so boot never depends on them.
 */
const NotificationChannelsFromAdapters = Layer.effect(
  NotificationChannels,
  Effect.gen(function* () {
    const email = yield* EmailSender;
    const push = yield* ExpoPushChannel;
    const sms = yield* SmsChannel;
    return {
      email: {
        send: (message) =>
          email
            .send({ to: message.to, subject: message.title, html: message.bodyHtml })
            // The channel interface speaks NotificationDeliveryError — fold
            // the underlying EmailError into it (transport trouble).
            .pipe(
              Effect.mapError(
                (error) =>
                  new NotificationDeliveryError({ kind: "provider", message: error.reason }),
              ),
              Effect.as({ providerMessageId: "email" }),
            ),
      },
      push,
      sms,
    };
  }),
);

export const NotificationChannelsLive = NotificationChannelsFromAdapters.pipe(
  Layer.provide(EmailSenderResendLive),
  Layer.provide(ExpoPushChannelLive),
  Layer.provide(SmsChannelLive),
);
