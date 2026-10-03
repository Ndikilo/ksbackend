import type { ConsultationType } from "@/domain/practitioner/practitioner";

/**
 * Appointment status machine: `pending → confirmed → cancelled | completed |
 * no_show`. Cancellation is legal from `pending` or `confirmed` only (booking
 * service enforces transitions; the DB pins the value set — see
 * `appointment_status_enum` in src/db/schema/enums.ts).
 */
export const APPOINTMENT_STATUSES = [
  "pending",
  "confirmed",
  "cancelled",
  "completed",
  "no_show",
] as const;
export type AppointmentStatus = (typeof APPOINTMENT_STATUSES)[number];

/** A confirmed-or-pending booking, with booking-time snapshots (P3.T1). */
export type Appointment = {
  readonly id: string;
  /** The account holder who booked (pays, cancels, is notified). */
  readonly patientUserId: string;
  /** null = booked for the patient themself. */
  readonly dependentId: string | null;
  readonly practitionerProfileId: string;
  readonly slotId: string;
  readonly consultationOfferingId: string;
  readonly status: AppointmentStatus;
  // Snapshots from the slot + offering at booking time — history survives
  // later offering edits and price changes.
  readonly consultationType: ConsultationType;
  readonly startsAt: Date;
  readonly endsAt: Date;
  readonly priceXaf: number;
  /** Cancellation policy in force when the booking was made (P3.T5). */
  readonly cancellationNoticeHours: number;
  readonly cancellationFeeXaf: number;
  readonly lateCancellation: boolean;
  /** Set iff status = 'cancelled' (CHECK-pinned). */
  readonly cancelledAt: Date | null;
  readonly cancelledByUserId: string | null;
};

/** Service-level booking request (HTTP validation lands with P3.T3). */
export type BookAppointmentInput = {
  readonly slotId: string;
  readonly offeringId: string;
  /** Omit = the patient books for themself. */
  readonly dependentId?: string | undefined;
};

/**
 * The practitioner-configurable cancellation policy (P3.T5): the notice window
 * (hours) and late-cancellation fee (XAF) applied to NEW bookings — each
 * appointment snapshots the values in force when it was made.
 */
export type BookingPolicy = {
  readonly noticeHours: number;
  readonly feeXaf: number;
};
