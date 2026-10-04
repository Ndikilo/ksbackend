import { SqlError } from "@effect/sql";
import { Clock, Context, Effect, Layer } from "effect";

import type { ChannelPreferences } from "@/domain/notification/notification";
import type { OutboxPayload } from "@/domain/notification/outbox";
import {
  REMINDER_HORIZONS,
  REMINDER_SCAN_WINDOW_MS,
  deliverableChannels,
  judgeReminder,
  reminderDedupKey,
  reminderScenario,
  type ReminderHorizon,
} from "@/domain/reminder/reminder";
import { formatClinicInstant, renderEmail } from "@/infra/email-render";
import { negotiateLocale, translate, type Locale } from "@/infra/i18n";
import { OutboxService } from "@/modules/outbox/outbox.service";
import { ReminderRepo, type ReminderCandidateRow } from "./reminder.repo";

/**
 * Reminder scheduler (P6.T2): ONE pass of the notifications worker.
 *
 * 1. SCAN confirmed appointments starting within the widest reminder horizon
 *    (repo.findDueCandidates).
 * 2. JUDGE each (appointment, horizon) pair against `now` with the pure
 *    window table (domain/reminder/reminder.ts) — cancelled appointments and
 *    bookings made inside a horizon's window are skipped here.
 * 3. ENQUEUE each due reminder through the notification outbox, gated by the
 *    user's `appointments` preference matrix and the channels this deployment
 *    can actually address. The outbox dedup key (`reminder-<h>:<id>`) makes
 *    double-enqueue impossible under concurrency: two racing passes (manual
 *    trigger, overlapping deploys) INSERT the same key and Postgres keeps one.
 * 4. DRAIN the outbox — claim due rows (FOR UPDATE SKIP LOCKED) and deliver
 *    them through the channel registry. Sends are therefore at-least-once
 *    per ROW, but at-most-one ROW per (appointment, horizon).
 *
 * Render discipline (P4.T1): the appointment time is rendered in the clinic
 * timezone (Africa/Douala) at ENQUEUE time — the payload is final; a drain
 * never re-renders.
 */

/** Outbox rows claimed per drain pass (one cron pass = one drain). */
const REMINDER_DRAIN_LIMIT = 100;

export type ReminderRunSummary = {
  readonly scanned: number;
  readonly enqueued: number;
  /** Enqueue attempts won by an earlier pass (dedup key already present). */
  readonly duplicates: number;
  /** Candidates×horizons judged not-confirmed / started / booked-too-late. */
  readonly skipped: number;
  readonly drain: {
    readonly claimed: number;
    readonly sent: number;
    readonly failed: number;
    readonly dead: number;
  };
};

export interface ReminderSchedulerService {
  /**
   * One scan+enqueue+drain pass at `now` (Clock-derived when omitted — tests
   * pass a fixed instant). Never throws on delivery trouble: channel failures
   * become failed/dead outbox rows (P6.T1 discipline).
   */
  readonly run: (input?: {
    readonly now?: Date;
  }) => Effect.Effect<ReminderRunSummary, SqlError.SqlError>;
}

export class ReminderScheduler extends Context.Tag("ReminderScheduler")<
  ReminderScheduler,
  ReminderSchedulerService
>() {}

const REMINDER_NS = {
  "24h": "emails.reminder24h",
  "1h": "emails.reminder1h",
} as const satisfies Record<ReminderHorizon, `emails.reminder${"24h" | "1h"}`>;

/** Render the FINAL localized payload from the appointment record. */
const reminderPayload = (
  candidate: ReminderCandidateRow,
  horizon: ReminderHorizon,
  locale: Locale,
): OutboxPayload => {
  const ns = REMINDER_NS[horizon];
  const params = {
    when: formatClinicInstant(locale, candidate.startsAt),
    practitioner: candidate.practitionerName,
  };
  return {
    title: translate(locale, `${ns}.subject`, params),
    bodyText: translate(locale, `${ns}.body`, params),
    bodyHtml: renderEmail(
      {
        kind: "reminder",
        horizon,
        when: candidate.startsAt,
        practitionerName: candidate.practitionerName,
      },
      locale,
    ).html,
  };
};

export const ReminderSchedulerLive = Layer.effect(
  ReminderScheduler,
  Effect.gen(function* () {
    const repo = yield* ReminderRepo;
    const outbox = yield* OutboxService;

    const run = (input?: { readonly now?: Date }) =>
      Effect.gen(function* () {
        const now = input?.now ?? new Date(yield* Clock.currentTimeMillis);
        const candidates = yield* repo.findDueCandidates({
          now,
          windowMs: REMINDER_SCAN_WINDOW_MS,
        });
        const preferences: ReadonlyMap<string, ChannelPreferences> =
          candidates.length === 0
            ? new Map()
            : yield* repo.preferencesFor(candidates.map((candidate) => candidate.patientUserId));

        let enqueued = 0;
        let duplicates = 0;
        let skipped = 0;

        for (const candidate of candidates) {
          // Email is the only channel with a resolvable recipient today — SMS
          // needs a phone identity (P8.T6), push a stored device token.
          const available = { email: candidate.patientEmail };
          for (const horizon of REMINDER_HORIZONS) {
            const decision = judgeReminder(candidate, horizon, now);
            if (decision.action === "wait") continue;
            if (decision.action === "skip") {
              skipped += 1;
              continue;
            }
            const locale = negotiateLocale(candidate.patientLocale ?? undefined, "fr");
            const payload = reminderPayload(candidate, horizon, locale);
            // `available` carries email only today, so the deliverable set is
            // ["email"] or [] — the loop generalizes without re-rendering when
            // SMS/push recipients arrive (P8.T6).
            for (const channel of deliverableChannels(
              preferences.get(candidate.patientUserId),
              available,
            )) {
              const row = yield* outbox.enqueue({
                userId: candidate.patientUserId,
                channel,
                category: "appointments",
                scenario: reminderScenario[horizon],
                locale,
                recipient: candidate.patientEmail,
                payload,
                availableAt: now,
                dedupKey: reminderDedupKey(candidate.id, horizon, channel),
              });
              if (row === undefined) duplicates += 1;
              else enqueued += 1;
            }
          }
        }

        const drain = yield* outbox.drain({ limit: REMINDER_DRAIN_LIMIT });
        return {
          scanned: candidates.length,
          enqueued,
          duplicates,
          skipped,
          drain,
        };
      });

    return { run };
  }),
);
