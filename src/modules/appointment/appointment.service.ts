import { SqlClient, SqlError } from "@effect/sql";
import { Clock, Context, Effect, Layer } from "effect";

import type { Appointment, BookAppointmentInput } from "@/domain/appointment/appointment";
import { SlotTaken } from "@/domain/appointment/errors";
import { Forbidden, NotFound, ValidationFailed } from "@/domain/shared/errors";
import { IdGenerator } from "@/infra/ids";
import { DependentRepo } from "@/modules/dependent/dependent.repo";
import { OfferingRepo } from "@/modules/offering/offering.repo";
import { AppointmentRepo } from "./appointment.repo";

/**
 * Cancellation policy snapshot defaults stamped onto every booking until
 * P3.T5 makes the policy practitioner-configurable (the appointment row keeps
 * the values that were in force at booking time either way).
 */
const BOOKING_CANCELLATION_NOTICE_HOURS = 24;
const BOOKING_CANCELLATION_FEE_XAF = 0;

export interface AppointmentServiceService {
  /**
   * Book one availability slot for the patient themself (`dependentId`
   * omitted) or a managed dependent. Atomic: the slot row is locked for the
   * whole transaction, so of two concurrent bookings on one slot EXACTLY ONE
   * wins — the loser fails with `SlotTaken` (409 SLOT_TAKEN). The partial
   * unique index `appointment_slot_active_unique` is the DB-level backstop.
   */
  readonly book: (
    patientUserId: string,
    input: BookAppointmentInput,
  ) => Effect.Effect<
    Appointment,
    SlotTaken | ValidationFailed | NotFound | Forbidden | SqlError.SqlError
  >;
}

export class AppointmentService extends Context.Tag("AppointmentService")<
  AppointmentService,
  AppointmentServiceService
>() {}

export const AppointmentServiceLive = Layer.effect(
  AppointmentService,
  Effect.gen(function* () {
    const repo = yield* AppointmentRepo;
    const offerings = yield* OfferingRepo;
    const dependents = yield* DependentRepo;
    const ids = yield* IdGenerator;
    const sql = yield* SqlClient.SqlClient;

    const book = (patientUserId: string, input: BookAppointmentInput) =>
      Effect.gen(function* () {
        const now = new Date(yield* Clock.currentTimeMillis);
        // The offering is resolved BEFORE the transaction: it only feeds the
        // coherence checks + snapshots, so it needs no lock (soft-deleted or
        // deactivated offerings simply fail the checks below).
        const offering = yield* offerings.findActiveById(input.offeringId);
        if (!offering) {
          return yield* Effect.fail(
            new NotFound({ resource: "Consultation offering", id: input.offeringId }),
          );
        }
        if (input.dependentId !== undefined) {
          const linked = yield* dependents.findForCaregiver(patientUserId, input.dependentId);
          if (!linked) {
            return yield* Effect.fail(
              new Forbidden({ reason: "Dependent is not managed by this account." }),
            );
          }
        }

        return yield* sql.withTransaction(
          Effect.gen(function* () {
            // Serialization point: concurrent bookings on this slot queue here.
            const slot = yield* repo.lockSlotById(input.slotId);
            if (!slot) {
              return yield* Effect.fail(
                new NotFound({ resource: "Availability slot", id: input.slotId }),
              );
            }
            if (slot.practitionerProfileId !== offering.practitionerProfileId) {
              return yield* Effect.fail(
                new ValidationFailed({
                  issues: [
                    {
                      path: "offeringId",
                      message: "Offering does not belong to this slot's practitioner.",
                    },
                  ],
                }),
              );
            }
            if (slot.deletedAt !== null || slot.status !== "open") {
              return yield* Effect.fail(new SlotTaken({}));
            }
            if (slot.startsAt.getTime() <= now.getTime()) {
              return yield* Effect.fail(
                new ValidationFailed({
                  issues: [{ path: "slotId", message: "Slot has already started." }],
                }),
              );
            }
            const slotMinutes = (slot.endsAt.getTime() - slot.startsAt.getTime()) / 60_000;
            if (slotMinutes !== offering.durationMin) {
              return yield* Effect.fail(
                new ValidationFailed({
                  issues: [
                    {
                      path: "offeringId",
                      message: "Offering duration does not match the slot length.",
                    },
                  ],
                }),
              );
            }
            if (!slot.consultationTypes.includes(offering.consultationType)) {
              return yield* Effect.fail(
                new ValidationFailed({
                  issues: [
                    {
                      path: "offeringId",
                      message: "Offering consultation type is not offered on this slot.",
                    },
                  ],
                }),
              );
            }

            const appointment = yield* repo.insertAppointment({
              id: yield* ids.next,
              patientUserId,
              dependentId: input.dependentId ?? null,
              practitionerProfileId: slot.practitionerProfileId,
              slotId: slot.id,
              consultationOfferingId: offering.id,
              consultationType: offering.consultationType,
              startsAt: slot.startsAt,
              endsAt: slot.endsAt,
              priceXaf: offering.priceXaf,
              cancellationNoticeHours: BOOKING_CANCELLATION_NOTICE_HOURS,
              cancellationFeeXaf: BOOKING_CANCELLATION_FEE_XAF,
              createdAt: now,
              updatedAt: now,
            });
            yield* repo.markSlotBooked(slot.id, now);
            return appointment;
          }),
        );
      });

    return { book };
  }),
);
