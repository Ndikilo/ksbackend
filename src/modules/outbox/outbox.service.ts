import { SqlClient, SqlError } from "@effect/sql";
import { Clock, Context, Effect, Either, Layer } from "effect";

import {
  type OutboxChannel,
  type OutboxNotification,
  type OutboxPayload,
  OUTBOX_STALL_TIMEOUT_MS,
  failureOutcome,
  retryDelayMs,
} from "@/domain/notification/outbox";
import type { NotificationCategory } from "@/domain/notification/notification";
import { IdGenerator } from "@/infra/ids";
import { NotificationChannels } from "@/infra/notifications/channel";
import { OutboxRepo } from "./outbox.repo";

/**
 * Notification outbox service (P6.T1). Producers `enqueue` (never send
 * inline); the `drain` loop delivers due rows through the channel registry
 * and applies the pure retry policy (domain/notification/outbox.ts).
 *
 * Delivery is AT-LEAST-ONCE: a crash after the provider accepted but before
 * `sent` was recorded re-sends on the next drain. Channels tolerate that
 * (duplicate email/push is preferable to a lost appointment reminder); the
 * stall-claim window bounds the re-send blast radius.
 */

export type EnqueueInput = {
  readonly userId: string;
  readonly channel: OutboxChannel;
  readonly category: NotificationCategory;
  readonly scenario: string;
  readonly locale: string;
  readonly recipient: string;
  /** The RENDERED message (domain/notification/outbox.ts → OutboxPayload). */
  readonly payload: OutboxPayload;
  /** Schedule for later (reminders) — defaults to immediately due. */
  readonly availableAt?: Date;
  /**
   * Idempotency guard (P6.T2): when the key already exists the enqueue is a
   * database-level no-op and `enqueue` resolves to `undefined` — two racing
   * producers (e.g. concurrent scheduler scans) yield exactly one row.
   */
  readonly dedupKey?: string;
};

export interface OutboxServiceService {
  /**
   * Durable enqueue: INSERT a `pending` row, due immediately (or at the
   *  requested time). The user's action never waits on a provider. With a
   * `dedupKey` that already exists this resolves to `undefined` (skipped
   * duplicate) instead of the row.
   */
  readonly enqueue: (
    input: EnqueueInput,
  ) => Effect.Effect<OutboxNotification | undefined, SqlError.SqlError>;
  /**
   * One drain pass: claim due rows (pending+due, plus stale `sending` from a
   * crashed claim), send each through its channel, record the outcome.
   * Provider failures NEVER throw out of drain — they become `failed`/`dead`
   * rows with the error recorded (failed sends stay visible). Returns the
   * summary so a scheduler (P6.T2) can log it.
   */
  readonly drain: (input: { readonly limit: number }) => Effect.Effect<
    {
      readonly claimed: number;
      readonly sent: number;
      readonly failed: number;
      readonly dead: number;
    },
    SqlError.SqlError
  >;
  /** Failed sends are visible: the most recent failures/dead, newest first. */
  readonly failures: (
    limit: number,
  ) => Effect.Effect<ReadonlyArray<OutboxNotification>, SqlError.SqlError>;
}

export class OutboxService extends Context.Tag("OutboxService")<
  OutboxService,
  OutboxServiceService
>() {}

export const OutboxServiceLive = Layer.effect(
  OutboxService,
  Effect.gen(function* () {
    const repo = yield* OutboxRepo;
    const channels = yield* NotificationChannels;
    const ids = yield* IdGenerator;
    const sql = yield* SqlClient.SqlClient;

    const now: Effect.Effect<Date> = Effect.map(Clock.currentTimeMillis, (ms) => new Date(ms));

    const enqueue = (input: EnqueueInput) =>
      Effect.gen(function* () {
        const at = input.availableAt ?? (yield* now);
        return yield* repo.insert({
          id: yield* ids.next,
          userId: input.userId,
          channel: input.channel,
          category: input.category,
          scenario: input.scenario,
          locale: input.locale,
          recipient: input.recipient,
          payload: input.payload,
          status: "pending",
          attempts: 0,
          availableAt: at,
          createdAt: at,
          updatedAt: at,
          dedupKey: input.dedupKey ?? null,
        });
      });

    const deliver = (
      row: OutboxNotification,
    ): Effect.Effect<"sent" | "failed" | "dead", SqlError.SqlError> =>
      Effect.gen(function* () {
        const at = yield* now;
        const outcome = yield* channels[row.channel]
          .send({
            to: row.recipient,
            title: row.payload.title,
            bodyHtml: row.payload.bodyHtml,
            bodyText: row.payload.bodyText,
          })
          .pipe(Effect.either);
        if (Either.isRight(outcome)) {
          yield* repo.markSent(row.id, {
            providerMessageId: outcome.right.providerMessageId,
            sentAt: yield* now,
          });
          return "sent" as const;
        }
        const attempts = row.attempts + 1;
        const decision = failureOutcome(attempts);
        const reason = outcome.left.message;
        if (decision.status === "dead") {
          yield* repo.markDead(row.id, { attempts, lastError: reason, now: at });
          return "dead" as const;
        }
        yield* repo.markFailed(row.id, {
          attempts,
          lastError: reason,
          availableAt: new Date(at.getTime() + retryDelayMs(attempts)),
          now: at,
        });
        return "failed" as const;
      });

    const drain = (input: { readonly limit: number }) =>
      Effect.gen(function* () {
        const at = yield* now;
        // Claim in ONE transaction (row locks + the `sending` flip); the
        // actual provider sends happen AFTER the claim commits — locks are
        // never held across HTTP.
        const claimed = yield* sql.withTransaction(
          repo.claimDue({
            limit: input.limit,
            now: at,
            stallBefore: new Date(at.getTime() - OUTBOX_STALL_TIMEOUT_MS),
          }),
        );
        let sent = 0;
        let failed = 0;
        let dead = 0;
        for (const row of claimed) {
          const outcome = yield* deliver(row);
          if (outcome === "sent") sent += 1;
          else if (outcome === "dead") dead += 1;
          else failed += 1;
        }
        return { claimed: claimed.length, sent, failed, dead };
      });

    return {
      enqueue,
      drain,
      failures: (limit) => repo.findFailed(limit),
    };
  }),
);
