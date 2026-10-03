import type { AppointmentStatus } from "./appointment";

/**
 * The pure cancellation/reschedule policy (P3.T3; practitioner-CONFIGURABLE
 * inputs + the full rules engine land in P3.T5 — the appointment row's
 * snapshot values feed these functions either way).
 *
 * Judgements are pure functions of the appointment's booking-time snapshot,
 * so a policy change never rewrites history: each appointment is judged by
 * the rules that were in force when it was made.
 */

/** Statuses a patient/practitioner may still act on (cancel, reschedule). */
export const ACTIONABLE_STATUSES = ["pending", "confirmed"] as const;

export const isActionableStatus = (status: AppointmentStatus): boolean =>
  status === "pending" || status === "confirmed";

/**
 * True when the appointment has already started (or its start has passed) —
 * self-service cancel/reschedule stop at the start time, not after it.
 */
export const hasStarted = (startsAt: Date, now: Date): boolean =>
  now.getTime() >= startsAt.getTime();

/**
 * True when a cancellation happening `now` lands INSIDE the notice window —
 * i.e. less than `noticeHours` remain before the start. Such a cancellation is
 * still ALLOWED (late-cancel tracking: `lateCancellation` is stamped and the
 * snapshot fee applies at settlement) — this is a judgement, not a rejection.
 * The boundary is inclusive-on-time: with exactly `noticeHours` remaining the
 * cancellation is NOT late; one millisecond less is. A 0-hour notice window
 * means every cancellation before the start is on time.
 */
export const isLateCancellation = (startsAt: Date, noticeHours: number, now: Date): boolean => {
  const msRemaining = startsAt.getTime() - now.getTime();
  return msRemaining < noticeHours * 3_600_000;
};
