import { SqlError } from "@effect/sql";
import * as PgDrizzle from "@effect/sql-drizzle/Pg";
import { and, desc, eq, inArray, isNull, lt, or, sql, type SQL } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import { Context, Effect, Layer } from "effect";

import type {
  Appointment,
  AppointmentStatus,
  BookingPolicy,
} from "@/domain/appointment/appointment";
import { user } from "@/db/schema/auth";
import { appointment } from "@/db/schema/appointment";
import { availabilitySlot } from "@/db/schema/availability-slot";
import { dependent } from "@/db/schema/dependent";
import { practitionerProfile } from "@/db/schema/practitioner-profile";

type Row = typeof appointment.$inferSelect;
type SlotRow = typeof availabilitySlot.$inferSelect;

/** Keyset position for list pagination: the last row's (starts_at, id). */
export type AppointmentCursor = { readonly startsAt: Date; readonly id: string };

/**
 * One list row: the appointment plus the COUNTERPARTY display name — persona
 * naming for the two calendars (P7.T1). A practitioner's agenda names WHO each
 * booking is for (the dependent when booked for one, else the account holder);
 * a patient's list names the practitioner. Each scope leaves its own side
 * `null` — the caller already knows their own name.
 */
export type AppointmentListRow = {
  readonly appointment: Appointment;
  /** Practitioner-scope rows: the display name of the person booked for. */
  readonly patientName: string | null;
  /** Patient-scope rows: the practitioner's display name. */
  readonly practitionerName: string | null;
};

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
   * newest start first, optionally filtered by status. Rows carry the
   * practitioner's display name (`patientName` is null — P7.T1).
   */
  readonly listForPatient: (
    patientUserId: string,
    limit: number,
    before: AppointmentCursor | undefined,
    status: AppointmentStatus | undefined,
  ) => Effect.Effect<ReadonlyArray<AppointmentListRow>, SqlError.SqlError>;
  /**
   * Keyset page of one practitioner's calendar, newest start first. Rows name
   * WHO each booking is for (dependent name when booked for a dependent, else
   * the account holder's; `practitionerName` is null — P7.T1).
   */
  readonly listForPractitioner: (
    practitionerProfileId: string,
    limit: number,
    before: AppointmentCursor | undefined,
    status: AppointmentStatus | undefined,
  ) => Effect.Effect<ReadonlyArray<AppointmentListRow>, SqlError.SqlError>;
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
  /**
   * Confirm a PENDING appointment (P5.T3) — the ONLY write that produces
   * `confirmed`. Two callers, one guarded write: the checkout service calls it
   * inside the transaction that flips the charge to `succeeded` (the booking
   * cannot confirm without a succeeded payment), and the practitioner-driven
   * confirm of P7.T3 calls it under the appointment's row lock after the pure
   * `judgeConfirm` gate. Guarded on `status = 'pending'` (a meanwhile-cancelled
   * booking is never resurrected; the money is then held for the refund flow).
   * Returns undefined when the guard excluded the row.
   */
  readonly confirmAppointment: (
    id: string,
    now: Date,
  ) => Effect.Effect<Appointment | undefined, SqlError.SqlError>;
  /**
   * The practitioner's booking policy (P3.T5) — the values stamped onto NEW
   * bookings. FK-guaranteed to exist for any real slot/practitioner; a missing
   * row is a broken invariant → defect.
   */
  readonly policyForPractitioner: (
    practitionerProfileId: string,
  ) => Effect.Effect<BookingPolicy, SqlError.SqlError>;
  /** Replace the practitioner's booking policy; returns the stored values. */
  readonly updatePolicy: (
    practitionerProfileId: string,
    values: { readonly noticeHours: number; readonly feeXaf: number; readonly now: Date },
  ) => Effect.Effect<BookingPolicy | undefined, SqlError.SqlError>;
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

// Shared list predicate: scope owner + optional status filter + keyset cutoff.
const pageWhere = (
  owner: SQL,
  before: AppointmentCursor | undefined,
  status: AppointmentStatus | undefined,
) =>
  and(
    owner,
    status === undefined ? undefined : eq(appointment.status, status),
    before === undefined ? undefined : beforeCursor(before),
  );

// List ordering both scopes share: newest start first (keyset tiebreak on id).
const pageOrder = [desc(appointment.startsAt), desc(appointment.id)] as const;

export const AppointmentRepoLive = Layer.effect(
  AppointmentRepo,
  Effect.gen(function* () {
    const db = yield* PgDrizzle.PgDrizzle;

    // The practitioner's human name rides their USER row (better-auth); an
    // aliased join keeps it independent of the patient join (P6.T2 pattern).
    const practitionerUser = alias(user, "practitioner_user");

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
        db
          .select({
            appt: appointment,
            practitionerName: practitionerUser.name,
          })
          .from(appointment)
          .innerJoin(
            practitionerProfile,
            eq(appointment.practitionerProfileId, practitionerProfile.id),
          )
          .innerJoin(practitionerUser, eq(practitionerProfile.userId, practitionerUser.id))
          .where(pageWhere(eq(appointment.patientUserId, patientUserId), before, status))
          .orderBy(...pageOrder)
          .limit(limit)
          .pipe(
            Effect.map((rows) =>
              rows.map((r) => ({
                appointment: toDomain(r.appt),
                patientName: null,
                practitionerName: r.practitionerName,
              })),
            ),
          ),

      listForPractitioner: (practitionerProfileId, limit, before, status) =>
        db
          .select({
            appt: appointment,
            // WHO the booking is for: the dependent's own name when booked for
            // one (LEFT JOIN — history survives a dependent deletion), else
            // the account holder's (FK-guaranteed user row, the same source
            // the lifecycle notifications name both parties by).
            patientName: sql<string>`coalesce(${dependent.givenNames} || ' ' || ${dependent.surname}, ${user.name})`,
          })
          .from(appointment)
          .innerJoin(user, eq(appointment.patientUserId, user.id))
          .leftJoin(dependent, eq(appointment.dependentId, dependent.id))
          .where(
            pageWhere(eq(appointment.practitionerProfileId, practitionerProfileId), before, status),
          )
          .orderBy(...pageOrder)
          .limit(limit)
          .pipe(
            Effect.map((rows) =>
              rows.map((r) => ({
                appointment: toDomain(r.appt),
                patientName: r.patientName,
                practitionerName: null,
              })),
            ),
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

      confirmAppointment: (id, now) =>
        db
          .update(appointment)
          .set({ status: "confirmed", updatedAt: now })
          .where(and(eq(appointment.id, id), eq(appointment.status, "pending")))
          .returning()
          .pipe(Effect.map((rows) => (rows[0] ? toDomain(rows[0]) : undefined))),

      policyForPractitioner: (practitionerProfileId) =>
        db
          .select({
            noticeHours: practitionerProfile.cancellationNoticeHours,
            feeXaf: practitionerProfile.cancellationFeeXaf,
          })
          .from(practitionerProfile)
          .where(eq(practitionerProfile.id, practitionerProfileId))
          .limit(1)
          .pipe(
            Effect.flatMap((rows) =>
              rows[0]
                ? Effect.succeed(rows[0])
                : Effect.dieMessage(
                    `policyForPractitioner: practitioner profile ${practitionerProfileId} not found (FK violation).`,
                  ),
            ),
          ),

      updatePolicy: (practitionerProfileId, { noticeHours, feeXaf, now }) =>
        db
          .update(practitionerProfile)
          .set({ cancellationNoticeHours: noticeHours, cancellationFeeXaf: feeXaf, updatedAt: now })
          .where(eq(practitionerProfile.id, practitionerProfileId))
          .returning({
            noticeHours: practitionerProfile.cancellationNoticeHours,
            feeXaf: practitionerProfile.cancellationFeeXaf,
          })
          .pipe(Effect.map((rows) => rows[0])),
    };
  }),
);
