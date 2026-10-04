import { Context, Data, Effect } from "effect";

import { type OutboxChannel } from "@/domain/notification/outbox";

/**
 * Notification channel abstraction (P6.T1). The outbox drain (notification
 * module) talks to THIS seam only; behind it sit one adapter per channel:
 *
 * - `email` — the existing Resend-backed `EmailSender` (infra/email.ts),
 *   re-rendered per notification scenario;
 * - `push`  — Expo's push API (exp.host) for the mobile app's device tokens;
 * - `sms`   — a Twilio-backed adapter (provider credentials are a deploy-time
 *   user action — until set, sends fail per call with `not_configured`).
 *
 * Same philosophy as the payment rails (P5.T1): adapters read env with empty
 * fallbacks and fail PER CALL, so boot never depends on provider credentials,
 * and contract tests drive every adapter through a scripted fetch seam.
 */

/** One outbound message, already rendered for its channel. */
export type OutboundMessage = {
  /** Destination: email address, Expo push token, or MSISDN (E.164). */
  readonly to: string;
  /** Push/notification title (unused by plain SMS). */
  readonly title: string;
  /** The rendered body: email gets it as HTML, push/SMS as plain text. */
  readonly bodyHtml: string;
  readonly bodyText: string;
};

/** Adapter-level result of an accepted send: the provider's message handle. */
export type DeliveryReceipt = {
  readonly providerMessageId: string;
};

export class NotificationDeliveryError extends Data.TaggedError("NotificationDeliveryError")<{
  /** not_configured: creds missing (user-action). invalid_request: bad input.
   *  provider: transport/5xx trouble. unexpected_response: the provider
   *  answered outside its contract. */
  readonly kind: "not_configured" | "invalid_request" | "provider" | "unexpected_response";
  readonly message: string;
  readonly httpStatus?: number;
}> {}

/** One channel's sender. Deterministic, fully Effect — no thrown errors. */
export interface NotificationChannelSender {
  readonly send: (
    message: OutboundMessage,
  ) => Effect.Effect<DeliveryReceipt, NotificationDeliveryError>;
}

/** Registry of all channels, keyed by channel — the drain dispatches on it. */
export class NotificationChannels extends Context.Tag("NotificationChannels")<
  NotificationChannels,
  Readonly<Record<OutboxChannel, NotificationChannelSender>>
>() {}

/** Minimal HTTP seam the adapters run through — faked in contract tests. */
export type FetchJson = (
  url: string,
  init: {
    readonly method: string;
    readonly headers: Readonly<Record<string, string>>;
    readonly body?: string;
  },
) => Promise<{ readonly status: number; readonly body: unknown }>;

/** The real adapter transport: platform fetch + lenient body parse (a non-JSON
 *  payload decodes to null; the adapters' zod layer then rejects it as
 *  unexpected_response). Mirrors infra/payments/provider.ts's defaultFetchJson. */
export const defaultFetchJson: FetchJson = async (url, init) => {
  const response = await fetch(url, {
    method: init.method,
    headers: init.headers,
    body: init.body,
  });
  const body = await response.json().catch(() => null);
  return { status: response.status, body };
};

export type ChannelHttpDeps = {
  readonly baseUrl: string;
  readonly fetchJson: FetchJson;
};

/** Credentials gate shared by the adapters: fail per call, never at boot. */
export const requireCredential = (
  value: string,
  what: string,
): Effect.Effect<string, NotificationDeliveryError> =>
  value.trim() === ""
    ? Effect.fail(
        new NotificationDeliveryError({
          kind: "not_configured",
          message: `${what} is not configured (provider credentials are a deploy-time user action)`,
        }),
      )
    : Effect.succeed(value);
