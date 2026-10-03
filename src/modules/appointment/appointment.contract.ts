import { z } from "@hono/zod-openapi";

import { APPOINTMENT_STATUSES } from "@/domain/appointment/appointment";
import { CONSULTATION_TYPES } from "@/domain/practitioner/practitioner";
import { paginated } from "@/http/schemas";

/** Booking request: which slot, which offering, optionally for whom. */
export const BookAppointmentBody = z
  .object({
    slotId: z.uuid().openapi({
      description: "The availability slot to book (from the practitioner's public availability).",
      example: "3fa85f64-5717-4562-b3fc-2c963f66afa6",
    }),
    offeringId: z.uuid().openapi({
      description:
        "The consultation offering to book — must belong to the slot's practitioner and fit the slot.",
      example: "6f9619ff-8b86-d011-b42d-00c04fc964ff",
    }),
    dependentId: z.uuid().optional().openapi({
      description:
        "Book for a managed dependent instead of the caller themself. Omit for a self-booking.",
    }),
  })
  .openapi("BookAppointment");

/** Reschedule request: the only knob is the new slot — the offering is kept. */
export const RescheduleAppointmentBody = z
  .object({
    slotId: z.uuid().openapi({
      description: "The new availability slot. It must belong to the same practitioner.",
    }),
  })
  .openapi("RescheduleAppointment");

export const AppointmentStatusSchema = z.enum(APPOINTMENT_STATUSES).openapi({
  description:
    "Lifecycle status: pending → confirmed → cancelled | completed | no_show (cancel is legal from pending or confirmed only).",
  example: "pending",
});

export const AppointmentResponse = z
  .object({
    id: z.uuid().openapi({ description: "The appointment id." }),
    patientUserId: z.string().openapi({
      description: "The account holder who booked (and who pays/cancels).",
    }),
    dependentId: z.uuid().nullable().openapi({
      description: "The dependent the booking is for, or null for a self-booking.",
    }),
    practitionerProfileId: z.uuid().openapi({ description: "The booked practitioner." }),
    slotId: z.uuid().openapi({ description: "The (current) booked slot." }),
    consultationOfferingId: z.uuid().openapi({ description: "The booked offering." }),
    status: AppointmentStatusSchema,
    consultationType: z.enum(CONSULTATION_TYPES).openapi({
      description: "Snapshot from the offering at booking time.",
      example: "in_person",
    }),
    startsAt: z.string().openapi({ description: "ISO-8601 start (snapshot at booking)." }),
    endsAt: z.string().openapi({ description: "ISO-8601 end (snapshot at booking)." }),
    priceXaf: z.number().int().openapi({
      description: "Price in XAF (integer, no floats) — snapshot at booking time.",
      example: 5000,
    }),
    cancellationNoticeHours: z.number().int().openapi({
      description:
        "The practitioner's cancellation notice window in force at booking time. Cancelling with less time remaining is a LATE cancellation.",
      example: 24,
    }),
    cancellationFeeXaf: z.number().int().openapi({
      description: "Fee (XAF) applied when the cancellation is late — snapshot at booking time.",
      example: 0,
    }),
    lateCancellation: z.boolean().openapi({
      description: "True when this appointment was cancelled inside its notice window.",
    }),
    cancelledAt: z.string().nullable().openapi({
      description: "When the cancellation happened; set iff status is `cancelled`.",
    }),
    cancelledByUserId: z.string().nullable().openapi({
      description: "Who cancelled (patient or practitioner); set iff status is `cancelled`.",
    }),
  })
  .openapi("Appointment");

export const AppointmentsPage = paginated(AppointmentResponse).openapi("AppointmentsPage");

export const ListAppointmentsQuery = z
  .object({
    limit: z.coerce
      .number()
      .int()
      .min(1)
      .max(100)
      .default(20)
      .openapi({ description: "Max items per page (1–100, default 20).", example: 20 }),
    cursor: z.string().optional().openapi({
      description:
        "Opaque cursor: pass the previous page's `meta.nextCursor` to fetch the next page. Omit for the first page.",
    }),
    scope: z.enum(["patient", "practitioner"]).optional().openapi({
      description:
        "Which calendar to list. `patient` (the default): the caller's own + their managed dependents' bookings. `practitioner`: the caller's professional agenda — requires the doctor/nurse role (`403` otherwise) and a practitioner profile (`404`).",
    }),
    status: z.enum(APPOINTMENT_STATUSES).optional().openapi({
      description: "Only appointments with this status.",
      example: "pending",
    }),
  })
  .openapi("ListAppointmentsQuery");

export const AppointmentIdParam = z.object({
  id: z.uuid().openapi({
    description: "The appointment id (from a create or list response).",
    example: "0b9e6b1e-6f1a-4d3e-9d2a-6f1a4d3e9d2a",
  }),
});

/**
 * The practitioner's booking policy (P3.T5). Applied to NEW bookings only —
 * existing appointments keep the snapshot taken when they were made.
 */
export const BookingPolicyBody = z
  .object({
    noticeHours: z.number().int().min(0).max(720).openapi({
      description:
        "Cancellation notice window in hours (0–720): a patient cancelling with less time remaining than this is a LATE cancellation.",
      example: 24,
    }),
    feeXaf: z.number().int().min(0).openapi({
      description:
        "Late-cancellation fee in XAF (integer, no floats), applied when the cancellation is late.",
      example: 2500,
    }),
  })
  .openapi("BookingPolicy");

export const BookingPolicyResponse = BookingPolicyBody.openapi("BookingPolicyCurrent");
