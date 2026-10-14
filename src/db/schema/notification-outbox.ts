import { sql } from "drizzle-orm";
import {
  check,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";

import { user } from "./auth";
import { notificationCategoryEnum, notificationChannelEnum, outboxStatusEnum } from "./enums";

/**
 * Notification outbox (P6.T1): the durable record of every outbound
 * notification. Producers INSERT (`pending`) at the moment of the event —
 * never send inline — and the drain loop delivers asynchronously, so a
 * provider outage delays delivery instead of failing the user's action.
 *
 * Retry states: `pending` → `sending` (claimed) → `sent`; a failed attempt
 * marks `failed` with `attempts`+1 and an `availableAt` backoff, becoming
 * claimable again until the budget exhausts (`dead`). A row stuck `sending`
 * past the stall timeout is reclaimable — the claim is not trusted to return.
 * Failed/dead rows are kept for inspection (never deleted on failure).
 */
export const notificationOutbox = pgTable(
  "notification_outbox",
  {
    id: uuid("id").primaryKey(),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    channel: notificationChannelEnum("channel").notNull(),
    // Which preference matrix row governs delivery (gating lands in P6.T4).
    category: notificationCategoryEnum("category").notNull(),
    // Template key (e.g. `receipt`) — senders render it locale-aware.
    scenario: text("scenario").notNull(),
    locale: text("locale").notNull(),
    // Destination: email address, Expo push token, or MSISDN (E.164).
    recipient: text("recipient").notNull(),
    // Template variables, JSON-serializable.
    payload: jsonb("payload").notNull(),
    status: outboxStatusEnum("status").notNull().default("pending"),
    attempts: integer("attempts").notNull().default(0),
    lastError: text("last_error"),
    // Provider handle after an accepted send (Resend id / Expo ticket / SMS sid).
    providerMessageId: text("provider_message_id"),
    // Producer-minted idempotency guard (P6.T2): `reminder-24h:<appointmentId>:<channel>`
    // and friends. Two racing producers INSERT the same key; the UNIQUE
    // index + ON CONFLICT DO NOTHING keep exactly one row — double-enqueue is
    // impossible at the database level (same discipline as payment.idempotency
    // _key). NULL (ad-hoc sends) never conflicts: Postgres treats NULLs as
    // distinct in unique indexes.
    dedupKey: text("dedup_key"),
    // Earliest reclaim time (backoff after failure / scheduled send).
    availableAt: timestamp("available_at", { withTimezone: true, mode: "date" }).notNull(),
    sentAt: timestamp("sent_at", { withTimezone: true, mode: "date" }),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "date" }).notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true, mode: "date" }).notNull(),
  },
  (t) => [
    index("notification_outbox_user_id_idx").on(t.userId),
    // The drain query: due work first, oldest available first.
    index("notification_outbox_drain_idx").on(t.status, t.availableAt),
    // Idempotent enqueue: one row per dedup key, ever (P6.T2). Plain UNIQUE —
    // the many-NULL rows never participate (NULLs are distinct in Postgres).
    uniqueIndex("notification_outbox_dedup_key_unique").on(t.dedupKey),
    check("notification_outbox_attempts_non_negative", sql`${t.attempts} >= 0`),
    // `sent` ⟺ a sent timestamp exists (same pin discipline as payment.refunded).
    check(
      "notification_outbox_sent_at_status",
      sql`(${t.status} = 'sent') = (${t.sentAt} is not null)`,
    ),
  ],
);
