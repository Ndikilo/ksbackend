import { SqlError } from "@effect/sql";
import * as PgDrizzle from "@effect/sql-drizzle/Pg";
import { and, eq, isNull } from "drizzle-orm";
import { Context, Effect, Layer } from "effect";

import type { Appointment } from "@/domain/appointment/appointment";
import { appointment } from "@/db/schema/appointment";
import { availabilitySlot } from "@/db/schema/availability-slot";

type Row = typeof appointment.$inferSelect;
type SlotRow = typeof availabilitySlot.$inferSelect;

const toDomain = (r: Row): Appointment => ({
  id: r.id,
  patientUserId: r.patientUserId,
  dependentId: r.dependentId,
  practitionerProfileId: r.practitionerProfileId,
  slotId: r.slotId,
  consultationOfferingId: r.consultationOfferingId,
  status: r.status,
  consultationType: r.consultationType,
  startsAt: r.startsAt,
  endsAt: r.endsAt,
  priceXaf: r.priceXaf,
  cancellationNoticeHours: r.cancellationNoticeHours,
  cancellationFeeXaf: r.cancellationFeeXaf,
  lateCancellation: r.lateCancellation,
  cancelledAt: r.cancelledAt,
  cancelledByUserId: r.cancelledByUserId,
});

export interface AppointmentRepoService {
  /**
   * Row-lock a slot (`SELECT … FOR UPDATE`) — the booking serialization point.
   * Two concurrent bookings on one slot line up here; the second re-checks
   * slot state after the first commits and fails with SlotTaken (P3.T2).
   */
  readonly lockSlotById: (id: string) => Effect.Effect<SlotRow | undefined, SqlError.SqlError>;
  /** Flip a locked slot to `booked`. Absent row = broken invariant → defect. */
  readonly markSlotBooked: (
    slotId: string,
    updatedAt: Date,
  ) => Effect.Effect<void, SqlError.SqlError>;
  readonly insertAppointment: (
    row: typeof appointment.$inferInsert,
  ) => Effect.Effect<Appointment, SqlError.SqlError>;
}

export class AppointmentRepo extends Context.Tag("AppointmentRepo")<
  AppointmentRepo,
  AppointmentRepoService
>() {}

export const AppointmentRepoLive = Layer.effect(
  AppointmentRepo,
  Effect.gen(function* () {
    const db = yield* PgDrizzle.PgDrizzle;

    return {
      lockSlotById: (id) =>
        db
          .select()
          .from(availabilitySlot)
          .where(eq(availabilitySlot.id, id))
          .limit(1)
          // Row lock held until the surrounding transaction ends — the
          // serialization point that makes double-booking impossible.
          .for("update")
          .pipe(Effect.map((rows) => rows[0])),

      markSlotBooked: (slotId, updatedAt) =>
        db
          .update(availabilitySlot)
          .set({ status: "booked", updatedAt })
          .where(and(eq(availabilitySlot.id, slotId), isNull(availabilitySlot.deletedAt)))
          .returning({ id: availabilitySlot.id })
          .pipe(
            Effect.flatMap((rows) =>
              rows[0]
                ? Effect.void
                : Effect.dieMessage(`markSlotBooked: locked slot ${slotId} vanished mid-booking.`),
            ),
          ),

      insertAppointment: (row) =>
        db
          .insert(appointment)
          .values(row)
          .returning()
          .pipe(
            Effect.flatMap((rows) =>
              rows[0]
                ? Effect.succeed(toDomain(rows[0]))
                : Effect.dieMessage("Appointment insert returned no row."),
            ),
          ),
    };
  }),
);
