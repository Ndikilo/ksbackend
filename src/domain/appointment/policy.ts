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

/**
 * The cancellation rules engine. Pure: given the appointment's booking-time
 * snapshot (state, start, the practitioner's notice window + fee as of
 * booking) and WHO is cancelling, yields the decision the service must apply.
 * The window never REJECTS a patient cancellation — inside it the cancellation
 * is allowed but LATE and carries the snapshot fee (late-cancel tracking);
 * practitioner-initiated cancellations are never late, because the fee exists
 * to protect the practitioner's time, not the patient's.
 */
export type CancellationJudgement =
  | { readonly kind: "not-actionable"; readonly current: AppointmentStatus }
  | { readonly kind: "started" }
  | { readonly kind: "on-time" }
  | { readonly kind: "late"; readonly feeXaf: number };

export const judgeCancellation = (
  appointment: {
    readonly status: AppointmentStatus;
    readonly startsAt: Date;
    readonly cancellationNoticeHours: number;
    readonly cancellationFeeXaf: number;
  },
  now: Date,
  byPatient: boolean,
): CancellationJudgement => {
  if (!isActionableStatus(appointment.status)) {
    return { kind: "not-actionable", current: appointment.status };
  }
  if (hasStarted(appointment.startsAt, now)) {
    return { kind: "started" };
  }
  return byPatient &&
    isLateCancellation(appointment.startsAt, appointment.cancellationNoticeHours, now)
    ? { kind: "late", feeXaf: appointment.cancellationFeeXaf }
    : { kind: "on-time" };
};

/**
 * The practitioner-driven confirm (P7.T3): ONLY a still-PENDING appointment is
 * confirmable — `confirmed` is already firm (a second confirm is a state
 * violation, not a no-op), and cancelled/completed/no_show left the actionable
 * set. As with cancel/reschedule, the start time is the cutoff: a pending
 * request whose slot has begun can no longer be accepted.
 */
export type ConfirmJudgement =
  | { readonly kind: "not-confirmable"; readonly current: AppointmentStatus }
  | { readonly kind: "started" }
  | { readonly kind: "allowed" };

export const judgeConfirm = (
  appointment: { readonly status: AppointmentStatus; readonly startsAt: Date },
  now: Date,
): ConfirmJudgement => {
  if (appointment.status !== "pending") {
    return { kind: "not-confirmable", current: appointment.status };
  }
  return hasStarted(appointment.startsAt, now) ? { kind: "started" } : { kind: "allowed" };
};

/**
 * The reschedule half of the engine: while the appointment is actionable and
 * has not started it may be moved — the notice window does NOT gate
 * rescheduling (moving INTO more time is always an improvement; fees apply to
 * cancellations only). Everything else (target-slot fit) is judged by the
 * booking coherence rules, not by policy.
 */
export type RescheduleJudgement =
  | { readonly kind: "not-actionable"; readonly current: AppointmentStatus }
  | { readonly kind: "started" }
  | { readonly kind: "allowed" };

export const judgeReschedule = (
  appointment: { readonly status: AppointmentStatus; readonly startsAt: Date },
  now: Date,
): RescheduleJudgement => {
  if (!isActionableStatus(appointment.status)) {
    return { kind: "not-actionable", current: appointment.status };
  }
  return hasStarted(appointment.startsAt, now) ? { kind: "started" } : { kind: "allowed" };
};
