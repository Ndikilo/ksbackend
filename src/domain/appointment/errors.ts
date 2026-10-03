import { Data } from "effect";

/**
 * The slot is no longer bookable — another booking won it (active appointment
 * exists) or the practitioner published-then-cancelled it. Retryable: pick
 * another slot. The concurrency loser of two bookings on the same slot gets
 * this error (P3.T2); maps to 409 SLOT_TAKEN.
 */
export class SlotTaken extends Data.TaggedError("SlotTaken")<Record<string, never>> {}

/**
 * The requested state transition is not legal from the appointment's current
 * status — e.g. cancelling an already-cancelled appointment, rescheduling a
 * completed one. `current` is the status the appointment is actually in.
 * Maps to 409 APPOINTMENT_STATE_INVALID.
 */
export class AppointmentStateInvalid extends Data.TaggedError("AppointmentStateInvalid")<{
  readonly current: string;
}> {}

/**
 * The appointment's time has already started (or passed) — cancel/reschedule
 * are no longer possible through the self-service flow. Maps to 409
 * APPOINTMENT_STARTED.
 */
export class AppointmentStarted extends Data.TaggedError("AppointmentStarted")<
  Record<string, never>
> {}
