/**
 * Appointment lifecycle notifications (P6.T3): the PURE decision layer that
 * maps a lifecycle transition to the EXACT set of notifications it owes —
 * which recipient, which copy variant, under which outbox dedup key. No I/O;
 * fully table-tested; the orchestration (identity lookups, preference gating,
 * rendering, enqueue) lives in modules/appointment/notifications/.
 *
 * Transitions → notifications (the P6.T3 contract):
 *   booked      → patient + practitioner (the booking confirmation)
 *   confirmed   → patient (the booking is firm — payment-driven today; the
 *                 practitioner-driven confirm of P7 joins the same scenario)
 *   rescheduled → patient + practitioner (the NEW time)
 *   cancelled   → patient + practitioner, copy by WHO cancelled
 *   declined    → patient only (a practitioner cancelling a still-PENDING
 *                 request declined it — different event than cancelling a
 *                 confirmed appointment, different copy)
 *
 * The copy locale is each RECIPIENT's stored locale, resolved at enqueue time
 * by the orchestration (never the requester's Accept-Language — these rows are
 * delivered asynchronously by the notifications worker).
 */

import type { AppointmentStatus } from "./appointment";
import type { OutboxChannel } from "@/domain/notification/outbox";

/** The lifecycle events that enqueue notifications. */
export type LifecycleScenario = "booked" | "confirmed" | "rescheduled" | "cancelled" | "declined";

/** Who drove the transition — decides the cancellation copy variant. */
export type LifecycleActor = "patient" | "practitioner" | "admin";

/** Who receives a notification. Both parties of the appointment. */
export type LifecycleRecipient = "patient" | "practitioner";

/**
 * The copy variants — the locale namespace suffix under
 * `emails.appointment.<variant>.*` (subject/heading/body, en/fr). Patient-side
 * variants interpolate {when} + {practitioner}; practitioner-side {when} +
 * {patient}. infra/email-render renders from these (infra may import domain).
 */
export const LIFECYCLE_VARIANTS = [
  "booked-patient",
  "booked-practitioner",
  "confirmed-patient",
  "rescheduled-patient",
  "rescheduled-practitioner",
  "cancelled-self",
  "cancelled-by-patient",
  "cancelled-by-practitioner",
  "cancelled-self-practitioner",
  "cancelled-by-clinic",
  "cancelled-by-clinic-practitioner",
  "declined",
] as const;

export type LifecycleVariant = (typeof LIFECYCLE_VARIANTS)[number];

/** One planned notification: a recipient plus the copy variant they get. */
export type LifecyclePlanEntry = {
  readonly recipient: LifecycleRecipient;
  readonly variant: LifecycleVariant;
};

/** Outbox scenario id (template key) per lifecycle scenario. */
export const lifecycleScenarioId = {
  booked: "appointment-booked",
  confirmed: "appointment-confirmed",
  rescheduled: "appointment-rescheduled",
  cancelled: "appointment-cancelled",
  declined: "appointment-declined",
} satisfies Record<LifecycleScenario, string>;

/** Outbox scenario id for the payment receipt email (enqueued with `confirmed`). */
export const RECEIPT_SCENARIO_ID = "payment-receipt";

/**
 * A practitioner cancelling a still-PENDING request DECLINED it — the patient
 * never held a confirmed appointment, so the copy (and the recipient set)
 * differ from a cancellation. Everything else (any actor, from `confirmed`, or
 * a patient/admin cancel from either actionable status) is a cancellation.
 */
export const cancelScenario = (
  actor: LifecycleActor,
  priorStatus: AppointmentStatus,
): LifecycleScenario =>
  actor === "practitioner" && priorStatus === "pending" ? "declined" : "cancelled";

/** The EXACT notifications a lifecycle transition owes — no more, no fewer. */
export const lifecyclePlan = (
  scenario: LifecycleScenario,
  actor: LifecycleActor,
): ReadonlyArray<LifecyclePlanEntry> => {
  switch (scenario) {
    case "booked":
      return [
        { recipient: "patient", variant: "booked-patient" },
        { recipient: "practitioner", variant: "booked-practitioner" },
      ];
    case "confirmed":
      // The receipt email (payment proof) is enqueued alongside by the caller;
      // the confirmation itself goes to the patient only.
      return [{ recipient: "patient", variant: "confirmed-patient" }];
    case "rescheduled":
      return [
        { recipient: "patient", variant: "rescheduled-patient" },
        { recipient: "practitioner", variant: "rescheduled-practitioner" },
      ];
    case "cancelled":
      switch (actor) {
        case "patient":
          return [
            { recipient: "patient", variant: "cancelled-self" },
            { recipient: "practitioner", variant: "cancelled-by-patient" },
          ];
        case "practitioner":
          return [
            { recipient: "patient", variant: "cancelled-by-practitioner" },
            { recipient: "practitioner", variant: "cancelled-self-practitioner" },
          ];
        case "admin":
          // Refund-driven cancellation: the money is being returned, so the
          // patient copy says so; the practitioner loses the slot the same way.
          return [
            { recipient: "patient", variant: "cancelled-by-clinic" },
            { recipient: "practitioner", variant: "cancelled-by-clinic-practitioner" },
          ];
      }
    case "declined":
      // The practitioner acted themself — no self-notification.
      return [{ recipient: "patient", variant: "declined" }];
  }
};

/**
 * Outbox dedup key for ONE lifecycle notification row — the P6.T2 primitive
 * (`reminder-<horizon>:<id>`) generalized to (scenario, appointment,
 * recipient, channel). Every dimension that yields a distinct ROW must be in
 * the key: the UNIQUE index is global, so two recipients (or two channels) of
 * one transition sharing a key would silently swallow each other. Reschedule
 * is REPEATABLE, so its key carries the transition instant — a content-only
 * key would dedup a legitimate A→B→A move back to B (the practitioner would
 * believe the stale time). Terminal transitions are once-per-appointment by
 * the state machine, so their keys need no sequence.
 */
export const lifecycleDedupKey = (
  scenario: LifecycleScenario,
  appointmentId: string,
  recipient: LifecycleRecipient,
  channel: OutboxChannel,
  sequence?: number,
): string =>
  [
    lifecycleScenarioId[scenario],
    appointmentId,
    recipient,
    channel,
    sequence === undefined ? null : String(sequence),
  ]
    .filter((part) => part !== null)
    .join(":");

/**
 * The copy variants written FOR the practitioner (the recipient-facing set —
 * the remaining variants are written for the patient). The name each variant's
 * copy interpolates is the OTHER party: patient-facing copy names the
 * practitioner, practitioner-facing copy names the patient. The renderer and
 * the orchestration both read this, so ONE table decides whose name goes where.
 */
const PRACTITIONER_COPY: ReadonlySet<LifecycleVariant> = new Set<LifecycleVariant>([
  "booked-practitioner",
  "rescheduled-practitioner",
  "cancelled-by-patient",
  "cancelled-self-practitioner",
  "cancelled-by-clinic-practitioner",
]);

/** Which i18n name param carries a real name for this variant's copy. */
export const lifecycleNameParam = (variant: LifecycleVariant): LifecycleRecipient =>
  PRACTITIONER_COPY.has(variant) ? "patient" : "practitioner";

/**
 * Dedup key for the receipt email — once per PAYMENT (a terminal transition;
 * the payment id is unique and never re-driven through `succeeded` twice),
 * channel-scoped like every outbox key.
 */
export const receiptDedupKey = (paymentId: string, channel: OutboxChannel): string =>
  `${RECEIPT_SCENARIO_ID}:${paymentId}:${channel}`;
