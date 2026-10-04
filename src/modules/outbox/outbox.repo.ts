import { SqlError } from "@effect/sql";
import * as PgDrizzle from "@effect/sql-drizzle/Pg";
import { and, asc, eq, inArray, lte, or, sql } from "drizzle-orm";
import { Context, Effect, Layer } from "effect";
import { z } from "zod";

import { type OutboxNotification, type OutboxPayload } from "@/domain/notification/outbox";
import { notificationOutbox } from "@/db/schema/notification-outbox";

type Row = typeof notificationOutbox.$inferSelect;

/** jsonb is `unknown` at the driver boundary — decode, never cast. */
const OutboxPayloadDecode = z.object({
  title: z.string(),
  bodyText: z.string(),
  bodyHtml: z.string(),
});

const toDomain = (r: Row): OutboxNotification => ({
  id: r.id,
  userId: r.userId,
  channel: r.channel,
  category: r.category,
  scenario: r.scenario,
  locale: r.locale,
  recipient: r.recipient,
  payload: OutboxPayloadDecode.parse(r.payload) satisfies OutboxPayload,
  status: r.status,
  attempts: r.attempts,
  lastError: r.lastError,
  providerMessageId: r.providerMessageId,
  availableAt: r.availableAt,
  sentAt: r.sentAt,
  createdAt: r.createdAt,
  updatedAt: r.updatedAt,
});

export interface OutboxRepoService {
  /**
   * Insert a pending notification (the outbox pattern's write path). When the
   * row carries a `dedupKey` that already exists, the insert is a no-op and
   * `undefined` is returned — double-enqueue is impossible at the database
   * level (UNIQUE index + ON CONFLICT DO NOTHING, P6.T2).
   */
  readonly insert: (
    row: typeof notificationOutbox.$inferInsert,
  ) => Effect.Effect<OutboxNotification | undefined, SqlError.SqlError>;
  /**
   * Claim due work for one drain pass, in the caller's transaction:
   * rows that are `pending` and due (availableAt ≤ now), plus `sending` rows
   * whose claim went stale (updatedAt < stallBefore — a crash mid-send must
   * not strand a notification). `FOR UPDATE SKIP LOCKED` so concurrent drain
   * workers never fight over a row. Claimed rows flip to `sending`.
   */
  readonly claimDue: (input: {
    readonly limit: number;
    readonly now: Date;
    readonly stallBefore: Date;
  }) => Effect.Effect<ReadonlyArray<OutboxNotification>, SqlError.SqlError>;
  /** Mark a delivered row: `sent`, the provider's handle, the sent time. */
  readonly markSent: (
    id: string,
    values: { readonly providerMessageId: string; readonly sentAt: Date },
  ) => Effect.Effect<OutboxNotification | undefined, SqlError.SqlError>;
  /** Record a failed attempt: error, attempts count, next eligibility time. */
  readonly markFailed: (
    id: string,
    values: {
      readonly attempts: number;
      readonly lastError: string;
      readonly availableAt: Date;
      readonly now: Date;
    },
  ) => Effect.Effect<OutboxNotification | undefined, SqlError.SqlError>;
  /** Exhausted retry budget: terminal `dead`, kept for inspection. */
  readonly markDead: (
    id: string,
    values: { readonly attempts: number; readonly lastError: string; readonly now: Date },
  ) => Effect.Effect<OutboxNotification | undefined, SqlError.SqlError>;
  /** Failed sends are VISIBLE: the most recent non-terminal failures first. */
  readonly findFailed: (
    limit: number,
  ) => Effect.Effect<ReadonlyArray<OutboxNotification>, SqlError.SqlError>;
}

export class OutboxRepo extends Context.Tag("OutboxRepo")<OutboxRepo, OutboxRepoService>() {}

export const OutboxRepoLive = Layer.effect(
  OutboxRepo,
  Effect.gen(function* () {
    const db = yield* PgDrizzle.PgDrizzle;

    return {
      insert: (row) =>
        db
          .insert(notificationOutbox)
          .values(row)
          // Idempotent enqueue (P6.T2): a repeated dedup key resolves to the
          // EXISTING row — the insert contributes nothing and returns no row.
          .onConflictDoNothing({ target: notificationOutbox.dedupKey })
          .returning()
          .pipe(Effect.map((rows) => (rows[0] ? toDomain(rows[0]) : undefined))),

      claimDue: ({ limit, now, stallBefore }) =>
        // Runs inside the CALLER's transaction (the service wraps this in
        // SqlClient.withTransaction): the SELECT … FOR UPDATE SKIP LOCKED and
        // the `sending` flip are one atomic unit on the shared client.
        db
          .select()
          .from(notificationOutbox)
          .where(
            or(
              and(
                eq(notificationOutbox.status, "pending"),
                lte(notificationOutbox.availableAt, now),
              ),
              and(
                eq(notificationOutbox.status, "sending"),
                lte(notificationOutbox.updatedAt, stallBefore),
              ),
            ),
          )
          .orderBy(asc(notificationOutbox.availableAt))
          .limit(limit)
          // Concurrent drains skip each other's rows — at-least-once with
          // per-row exclusivity, no worker coordination needed.
          .for("update", { skipLocked: true })
          .pipe(
            Effect.flatMap((claimed) =>
              claimed.length === 0
                ? Effect.succeed([])
                : db
                    .update(notificationOutbox)
                    .set({ status: "sending", updatedAt: now })
                    .where(
                      inArray(
                        notificationOutbox.id,
                        claimed.map((r) => r.id),
                      ),
                    )
                    .returning()
                    .pipe(Effect.map((rows) => rows.map(toDomain))),
            ),
          ),

      markSent: (id, { providerMessageId, sentAt }) =>
        db
          .update(notificationOutbox)
          .set({
            status: "sent",
            providerMessageId,
            sentAt,
            lastError: null,
            updatedAt: sentAt,
          })
          .where(eq(notificationOutbox.id, id))
          .returning()
          .pipe(Effect.map((rows) => (rows[0] ? toDomain(rows[0]) : undefined))),

      markFailed: (id, { attempts, lastError, availableAt, now }) =>
        db
          .update(notificationOutbox)
          .set({ status: "failed", attempts, lastError, availableAt, updatedAt: now })
          .where(eq(notificationOutbox.id, id))
          .returning()
          .pipe(Effect.map((rows) => (rows[0] ? toDomain(rows[0]) : undefined))),

      markDead: (id, { attempts, lastError, now }) =>
        db
          .update(notificationOutbox)
          .set({ status: "dead", attempts, lastError, updatedAt: now })
          .where(eq(notificationOutbox.id, id))
          .returning()
          .pipe(Effect.map((rows) => (rows[0] ? toDomain(rows[0]) : undefined))),

      findFailed: (limit) =>
        db
          .select()
          .from(notificationOutbox)
          .where(sql`${notificationOutbox.status} in ('failed', 'dead')`)
          .orderBy(sql`${notificationOutbox.updatedAt} desc`)
          .limit(limit)
          .pipe(Effect.map((rows) => rows.map(toDomain))),
    };
  }),
);
