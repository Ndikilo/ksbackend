/**
 * Appointment reminder domain (P6.T2): the PURE decision layer behind the
 * reminder scheduler. Which confirmed appointment deserves which reminder at a
 * given instant, and under what dedup key the resulting notification is
 * enqueued — no I/O, fully table-tested.
 *
 * Time discipline: every computation happens on ABSOLUTE instants
 * (UTC milliseconds). `reminderDueAt` is exact lead-time arithmetic, never
 * wall-clock parsing — safe under any server timezone and correct for
 * Africa/Douala (fixed UTC+1, no DST). Rendering to humans is the renderer's
 * job (infra/email-render.ts pins Africa/Douala explicitly).
 */

import type { AppointmentStatus } from "@/domain/appointment/appointment";
import { deliverableChannels, type OutboxChannel } from "@/domain/notification/outbox";

// The preference intersection lives beside OUTBOX_CHANNELS (P6.T3 moved it
// there so lifecycle notifications gate through the same function); re-exported
// here for the reminder call sites and tests.
export { deliverableChannels };

/** How far ahead of the appointment each reminder fires. */
export type ReminderHorizon = "24h" | "1h";

export const REMINDER_HORIZONS: ReadonlyArray<ReminderHorizon> = ["24h", "1h"] as const;

/** Absolute lead time per horizon — instants, not wall-clock offsets. */
export const REMINDER_LEAD_MS = {
  "24h": 24 * 60 * 60_000,
  "1h": 60 * 60_000,
} satisfies Record<ReminderHorizon, number>;

/**
 * How far ahead one scan looks: the widest horizon. Anything starting later
 * has no due horizon yet and is picked up by a future pass.
 */
export const REMINDER_SCAN_WINDOW_MS = REMINDER_LEAD_MS["24h"];

/**
 * The instant a horizon's reminder becomes due for an appointment starting at
 * `startsAt`: exact subtraction on the absolute timeline (the DST/offset-safe
 * discipline — no local-time arithmetic anywhere).
 */
export const reminderDueAt = (startsAt: Date, horizon: ReminderHorizon): Date =>
  new Date(startsAt.getTime() - REMINDER_LEAD_MS[horizon]);

/**
 * Outbox dedup key for one (appointment, horizon, channel) reminder. The
 * outbox's UNIQUE dedup_key column makes double-enqueue impossible under
 * concurrency: two racing scheduler scans INSERT the same key, Postgres keeps
 * one (ON CONFLICT DO NOTHING). The CHANNEL is part of the key because the
 * index is global — the P6.T3 generalization (lifecycleDedupKey) applies it to
 * every producer: two channels of one reminder sharing a key would silently
 * swallow each other the moment a second channel becomes deliverable.
 */
export const reminderDedupKey = (
  appointmentId: string,
  horizon: ReminderHorizon,
  channel: OutboxChannel,
): string => `reminder-${horizon}:${appointmentId}:${channel}`;

/** Outbox scenario (template key) per horizon — failures()/inspection read it. */
export const reminderScenario = {
  "24h": "reminder-24h",
  "1h": "reminder-1h",
} satisfies Record<ReminderHorizon, string>;

/** The slice of the appointment row the judgement needs. */
export type ReminderCandidate = {
  readonly id: string;
  readonly status: AppointmentStatus;
  readonly startsAt: Date;
  readonly createdAt: Date;
};

export type ReminderDecision =
  | { readonly action: "enqueue" }
  | { readonly action: "wait" }
  | {
      readonly action: "skip";
      readonly reason: "not-confirmed" | "started" | "booked-too-late";
    };

/**
 * Should this horizon's reminder be enqueued for the candidate at `now`?
 *
 * - Only CONFIRMED appointments are reminded: `pending` is not a commitment
 *   yet (and cannot exist past payment without confirmation), cancelled /
 *   completed / no_show appointments must never remind.
 * - An appointment that already started (or is past) is never reminded.
 * - A booking made INSIDE the horizon window (createdAt after the due point)
 *   skips that horizon — the booking confirmation already covered it; a
 *   reminder 40 minutes after booking reads as noise.
 * - Boundary semantics: due exactly AT the due point (inclusive); the instant
 *   the appointment starts the window closes.
 */
export const judgeReminder = (
  candidate: ReminderCandidate,
  horizon: ReminderHorizon,
  now: Date,
): ReminderDecision => {
  if (candidate.status !== "confirmed") return { action: "skip", reason: "not-confirmed" };
  if (now.getTime() >= candidate.startsAt.getTime()) return { action: "skip", reason: "started" };
  const dueAt = reminderDueAt(candidate.startsAt, horizon);
  if (candidate.createdAt.getTime() > dueAt.getTime()) {
    return { action: "skip", reason: "booked-too-late" };
  }
  if (now.getTime() < dueAt.getTime()) return { action: "wait" };
  return { action: "enqueue" };
};
