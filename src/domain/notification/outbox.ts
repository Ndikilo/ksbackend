/**
 * Notification outbox domain (P6.T1): the durable record of EVERY outbound
 * notification (email / push / SMS) and its delivery lifecycle.
 *
 * The outbox pattern: a notification is INSERTED (`pending`) in the same
 * logical moment as the event it belongs to — never sent inline — and a drain
 * loop delivers rows asynchronously. Delivery states:
 *
 *   pending → sending → sent
 *                ↓  ↑ (stall recovery: a drain re-claims `sending` rows whose
 *                ↓  |  claim went stale — a crash mid-send must not strand one)
 *                ↓  └── after backoff: failed → sending (retry budget left)
 *                └────── attempts exhausted: dead (terminal, kept for inspection)
 *
 * `sent` and `dead` are terminal; `failed` rows stay eligible after a backoff
 * window; `sending` rows are re-claimable once the stall timeout passes (the
 * claim is not trusted to come back — the process may have died mid-send).
 */

import type { NotificationCategory } from "./notification";
import { defaultChannels, type ChannelPreferences } from "./notification";

export type OutboxChannel = "email" | "push" | "sms";

export const OUTBOX_CHANNELS = ["email", "push", "sms"] as const;

export type OutboxStatus = "pending" | "sending" | "sent" | "failed" | "dead";

export const OUTBOX_TERMINAL_STATUSES: ReadonlySet<OutboxStatus> = new Set(["sent", "dead"]);

/**
 * The rendered message a sender delivers. Producers render at enqueue time
 * (scenario + locale → concrete copy) so the outbox row is self-contained:
 * the drain needs no template registry to deliver, and a template edit can
 * never silently change the words of an already-enqueued notification.
 */
export type OutboxPayload = {
  /** Push/notification title; email subject. */
  readonly title: string;
  /** Plain-text body (push + SMS). */
  readonly bodyText: string;
  /** HTML body (email only). */
  readonly bodyHtml: string;
};

/** One durable outbound notification. */
export type OutboxNotification = {
  readonly id: string;
  readonly userId: string;
  readonly channel: OutboxChannel;
  /** Which preference category governs this notification (gating, P6.T4). */
  readonly category: NotificationCategory;
  /** Template key, e.g. `receipt` — audit/visibility, already rendered. */
  readonly scenario: string;
  /** Destination string: email address, Expo push token, or MSISDN. */
  readonly recipient: string;
  /** ISO-639-1 render locale for the template ("en" | "fr"). */
  readonly locale: string;
  /** The rendered message (see OutboxPayload). */
  readonly payload: OutboxPayload;
  readonly status: OutboxStatus;
  readonly attempts: number;
  readonly lastError: string | null;
  /** Provider handle after an accepted send (Resend id, Expo ticket id, SMS sid). */
  readonly providerMessageId: string | null;
  /** Earliest time the row may be claimed again (backoff / scheduled send). */
  readonly availableAt: Date;
  readonly sentAt: Date | null;
  readonly createdAt: Date;
  readonly updatedAt: Date;
};

//── Retry policy (pure — unit-tested in outbox.test.ts) ──────────────────────

/** Total delivery attempts before a row goes `dead`. */
export const OUTBOX_MAX_ATTEMPTS = 5;
/** First retry waits 1 minute; each failure doubles the wait, capped. */
export const OUTBOX_BASE_RETRY_MS = 60_000;
export const OUTBOX_MAX_RETRY_MS = 60 * 60_000; // 1 hour cap
/** A `sending` row older than this was lost to a crash — reclaim it. */
export const OUTBOX_STALL_TIMEOUT_MS = 10 * 60_000;

/**
 * Exponential backoff for attempt N (1-based): 1 min, 2 min, 4 min, 8 min —
 * capped at OUTBOX_MAX_RETRY_MS. Pure so the schedule is pinned by tests.
 */
export const retryDelayMs = (attempt: number): number => {
  const raw = OUTBOX_BASE_RETRY_MS * 2 ** Math.max(0, attempt - 1);
  return Math.min(raw, OUTBOX_MAX_RETRY_MS);
};

/**
 * What a drain does with a failed attempt: retry (with a new `availableAt`)
 * while the budget lasts, then kill the row. Pure decision, unit-tested.
 */
export const failureOutcome = (
  attemptsAfterFailure: number,
): { readonly status: "failed" | "dead"; readonly availableAt: "backoff" | "none" } =>
  attemptsAfterFailure >= OUTBOX_MAX_ATTEMPTS
    ? { status: "dead", availableAt: "none" }
    : { status: "failed", availableAt: "backoff" };

/**
 * Which channels a notification for this category may actually use (P6.T2/T4):
 * the user's stored preference INTERSECTED with the channels this deployment
 * can address for THEM (an email address / a stored device token / a phone
 * identity). Gating happens here, at ENQUEUE time — a switched-off channel
 * enqueues NOTHING (rather than enqueueing a row a later stage drops), so the
 * outbox row count is the truth about what was ever meant to be delivered.
 * Lives beside OUTBOX_CHANNELS so every producer gates through one function.
 */
export const deliverableChannels = (
  stored: ChannelPreferences | undefined,
  available: Partial<Record<OutboxChannel, string>>,
): ReadonlyArray<OutboxChannel> => {
  const prefs = stored ?? defaultChannels("appointments");
  return OUTBOX_CHANNELS.filter((channel) => prefs[channel] && available[channel] !== undefined);
};
