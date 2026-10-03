import { SqlError } from "@effect/sql";
import * as PgDrizzle from "@effect/sql-drizzle/Pg";
import { and, desc, eq, inArray, isNull, lt, or, type SQL } from "drizzle-orm";
import { Context, Effect, Layer } from "effect";

import type { Appointment, AppointmentStatus } from "@/domain/appointment/appointment";
import { appointment } from "@/db/schema/appointment";
import { availabilitySlot } from "@/db/schema/availability-slot";

type Row = typeof appointment.$inferSelect;
type SlotRow = typeof availabilitySlot.$inferSelect;

/** Keyset position for list pagination: the last row's (starts_at, id). */
export type AppointmentCursor = { readonly startsAt: Date; readonly id: string };

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
  /**
   * Release a booked slot back to `open` (cancel/reschedule). Slots the
   * practitioner soft-deleted meanwhile are NOT resurrected — they stay dead
   * and simply stop being bookable.
   */
  readonly markSlotOpen: (
    slotId: string,
    updatedAt: Date,
  ) => Effect.Effect<void, SqlError.SqlError>;
  readonly insertAppointment: (
    row: typeof appointment.$inferInsert,
  ) => Effect.Effect<Appointment, SqlError.SqlError>;
  /** Plain read (no lock) — `get` and the party check before writes. */
  readonly findById: (id: string) => Effect.Effect<Appointment | undefined, SqlError.SqlError>;
  /**
   * Row-lock an appointment (`SELECT … FOR UPDATE`) — the serialization point
   * for cancel/reschedule, so two concurrent mutations of one appointment
   * queue and the second re-checks state after the first commits.
   */
  readonly lockById: (id: string) => Effect.Effect<Appointment | undefined, SqlError.SqlError>;
  /**
   * Keyset page for the booking patient (their own + their managed
   * dependents' — every booking carries the account holder's user id),
   * newest start first, optionally filtered by status.
   */
  readonly listForPatient: (
    patientUserId: string,
    limit: number,
    before: AppointmentCursor | undefined,
    status: AppointmentStatus | undefined,
  ) => Effect.Effect<ReadonlyArray<Appointment>, SqlError.SqlError>;
  /** Keyset page of one practitioner's calendar, newest start first. */
  readonly listForPractitioner: (
    practitionerProfileId: string,
    limit: number,
    before: AppointmentCursor | undefined,
    status: AppointmentStatus | undefined,
  ) => Effect.Effect<ReadonlyArray<Appointment>, SqlError.SqlError>;
  /**
   * Cancel: stamp the audit fields + late flag in ONE guarded write. The
   * `status IN (pending, confirmed)` guard makes the state machine
   * DB-enforced even if the caller's lock were lost. Absent row under the
   * lock = broken invariant → defect.
   */
  readonly cancelAppointment: (
    id: string,
    values: { readonly byUserId: string; readonly late: boolean; readonly now: Date },
  ) => Effect.Effect<Appointment, SqlError.SqlError>;
  /** Move an actionable appointment to a new (already-locked) slot. */
  readonly rescheduleAppointment: (
    id: string,
    values: {
      readonly slotId: string;
      readonly startsAt: Date;
      readonly endsAt: Date;
      readonly now: Date;
    },
  ) => Effect.Effect<Appointment, SqlError.SqlError>;
}

export class AppointmentRepo extends Context.Tag("AppointmentRepo")<
  AppointmentRepo,
  AppointmentRepoService
>() {}

// Keyset predicate for "strictly before" a (starts_at, id) position on a
// newest-first ordering — used by both list directions.
const beforeCursor = (before: AppointmentCursor) =>
  or(
    lt(appointment.startsAt, before.startsAt),
    and(eq(appointment.startsAt, before.startsAt), lt(appointment.id, before.id)),
  );

export const AppointmentRepoLive = Layer.effect(
  AppointmentRepo,
  Effect.gen(function* () {
    const db = yield* PgDrizzle.PgDrizzle;

    const listPage = (
      owner: SQL,
      limit: number,
      before: AppointmentCursor | undefined,
      status: AppointmentStatus | undefined,
    ) =>
      db
        .select()
        .from(appointment)
        .where(
          and(
            owner,
            status === undefined ? undefined : eq(appointment.status, status),
            before === undefined ? undefined : beforeCursor(before),
          ),
        )
        .orderBy(desc(appointment.startsAt), desc(appointment.id))
        .limit(limit)
        .pipe(Effect.map((rows) => rows.map(toDomain)));

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

      markSlotOpen: (slotId, updatedAt) =>
        db
          .update(availabilitySlot)
          .set({ status: "open", updatedAt })
          // Guard: only an alive, still-booked slot flips back — a slot the
          // practitioner soft-deleted meanwhile is never resurrected.
          .where(
            and(
              eq(availabilitySlot.id, slotId),
              eq(availabilitySlot.status, "booked"),
              isNull(availabilitySlot.deletedAt),
            ),
          )
          .returning({ id: availabilitySlot.id })
          .pipe(Effect.map(() => undefined)),

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

      findById: (id) =>
        db
          .select()
          .from(appointment)
          .where(eq(appointment.id, id))
          .limit(1)
          .pipe(Effect.map((rows) => (rows[0] ? toDomain(rows[0]) : undefined))),

      lockById: (id) =>
        db
          .select()
          .from(appointment)
          .where(eq(appointment.id, id))
          .limit(1)
          // Row lock held until the transaction ends — cancel/reschedule
          // serialize here (P3.T3).
          .for("update")
          .pipe(Effect.map((rows) => (rows[0] ? toDomain(rows[0]) : undefined))),

      listForPatient: (patientUserId, limit, before, status) =>
        listPage(eq(appointment.patientUserId, patientUserId), limit, before, status),

      listForPractitioner: (practitionerProfileId, limit, before, status) =>
        listPage(
          eq(appointment.practitionerProfileId, practitionerProfileId),
          limit,
          before,
          status,
        ),

      cancelAppointment: (id, { byUserId, late, now }) =>
        db
          .update(appointment)
          .set({
            status: "cancelled",
            cancelledAt: now,
            cancelledByUserId: byUserId,
            lateCancellation: late,
            updatedAt: now,
          })
          // The state machine's write guard — only actionable appointments
          // can flip to cancelled (the CHECK pins cancelled ⟺ cancelledAt).
          .where(and(eq(appointment.id, id), inArray(appointment.status, ["pending", "confirmed"])))
          .returning()
          .pipe(
            Effect.flatMap((rows) =>
              rows[0]
                ? Effect.succeed(toDomain(rows[0]))
                : Effect.dieMessage(
                    `cancelAppointment: appointment ${id} vanished or changed state under its lock.`,
                  ),
            ),
          ),

      rescheduleAppointment: (id, { slotId, startsAt, endsAt, now }) =>
        db
          .update(appointment)
          .set({ slotId, startsAt, endsAt, updatedAt: now })
          .where(and(eq(appointment.id, id), inArray(appointment.status, ["pending", "confirmed"])))
          .returning()
          .pipe(
            Effect.flatMap((rows) =>
              rows[0]
                ? Effect.succeed(toDomain(rows[0]))
                : Effect.dieMessage(
                    `rescheduleAppointment: appointment ${id} vanished or changed state under its lock.`,
                  ),
            ),
          ),
    };
  }),
);
