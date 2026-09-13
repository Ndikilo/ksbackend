import { SqlError } from "@effect/sql";
import * as PgDrizzle from "@effect/sql-drizzle/Pg";
import { and, asc, desc, eq, gt, gte, isNull, lt, lte } from "drizzle-orm";
import { Context, Effect, Layer } from "effect";
import { availabilityException } from "@/db/schema/availability-exception";
import { availabilityRule } from "@/db/schema/availability-rule";
import { availabilitySlot } from "@/db/schema/availability-slot";
import { practitionerProfile } from "@/db/schema/practitioner-profile";
import type {
  AvailabilityException,
  AvailabilityRule,
  AvailabilitySlot,
} from "@/domain/availability/availability";
import type { ConsultationType } from "@/domain/practitioner/practitioner";

type Row = typeof availabilitySlot.$inferSelect;

export type NewSlotRow = {
  readonly id: string;
  readonly practitionerProfileId: string;
  readonly startsAt: Date;
  readonly endsAt: Date;
  readonly consultationTypes: ReadonlyArray<ConsultationType>;
  readonly locationId: string | null;
  readonly createdAt: Date;
  readonly updatedAt: Date;
};

const toDomain = (r: Row): AvailabilitySlot => ({
  id: r.id,
  practitionerProfileId: r.practitionerProfileId,
  startsAt: r.startsAt,
  endsAt: r.endsAt,
  consultationTypes: r.consultationTypes,
  locationId: r.locationId,
  status: r.status,
});

const ruleToDomain = (row: typeof availabilityRule.$inferSelect): AvailabilityRule => ({
  id: row.id,
  practitionerProfileId: row.practitionerProfileId,
  weekday: row.weekday,
  startTime: row.startTime,
  endTime: row.endTime,
  slotDurationMin: row.slotDurationMin,
  consultationTypes: row.consultationTypes,
  locationId: row.locationId,
  timezone: "Africa/Douala",
  validFrom: row.validFrom,
  validTo: row.validTo,
});

const exceptionToDomain = (
  row: typeof availabilityException.$inferSelect,
): AvailabilityException => ({
  id: row.id,
  practitionerProfileId: row.practitionerProfileId,
  date: row.date,
  kind: row.kind,
  startTime: row.startTime,
  endTime: row.endTime,
  consultationTypes: row.consultationTypes,
  locationId: row.locationId,
});

export interface AvailabilityRepoService {
  /** The practitioner_profile id owned by a user (undefined if they aren't a practitioner). */
  readonly practitionerIdForUser: (
    userId: string,
  ) => Effect.Effect<string | undefined, SqlError.SqlError>;
  /** Whether an active slot for this practitioner intersects [startsAt, endsAt). */
  readonly overlaps: (
    practitionerProfileId: string,
    startsAt: Date,
    endsAt: Date,
  ) => Effect.Effect<boolean, SqlError.SqlError>;
  readonly insert: (row: NewSlotRow) => Effect.Effect<AvailabilitySlot, SqlError.SqlError>;
  readonly slotIdExists: (id: string) => Effect.Effect<boolean, SqlError.SqlError>;
  readonly listByPractitioner: (
    practitionerProfileId: string,
    limit: number,
    beforeId: string | undefined,
  ) => Effect.Effect<ReadonlyArray<AvailabilitySlot>, SqlError.SqlError>;
  /** Owner-scoped soft delete; resolves to whether a row was affected. */
  readonly softDelete: (
    practitionerProfileId: string,
    slotId: string,
    deletedAt: Date,
  ) => Effect.Effect<boolean, SqlError.SqlError>;
  /** The soonest open, future, non-deleted slot start (null if none). */
  readonly nextAvailableAt: (
    practitionerProfileId: string,
    now: Date,
  ) => Effect.Effect<Date | null, SqlError.SqlError>;
  readonly replaceRules: (
    practitionerProfileId: string,
    rows: ReadonlyArray<typeof availabilityRule.$inferInsert>,
  ) => Effect.Effect<ReadonlyArray<AvailabilityRule>, SqlError.SqlError>;
  readonly listRules: (
    practitionerProfileId: string,
  ) => Effect.Effect<ReadonlyArray<AvailabilityRule>, SqlError.SqlError>;
  readonly insertException: (
    row: typeof availabilityException.$inferInsert,
  ) => Effect.Effect<AvailabilityException, SqlError.SqlError>;
  readonly exceptionIdExists: (id: string) => Effect.Effect<boolean, SqlError.SqlError>;
  readonly listExceptions: (
    practitionerProfileId: string,
    fromDate: string,
    toDate: string,
  ) => Effect.Effect<ReadonlyArray<AvailabilityException>, SqlError.SqlError>;
  readonly softDeleteException: (
    practitionerProfileId: string,
    id: string,
    deletedAt: Date,
  ) => Effect.Effect<boolean, SqlError.SqlError>;
  readonly listSlotsInRange: (
    practitionerProfileId: string,
    from: Date,
    to: Date,
  ) => Effect.Effect<ReadonlyArray<AvailabilitySlot>, SqlError.SqlError>;
}

export class AvailabilityRepo extends Context.Tag("AvailabilityRepo")<
  AvailabilityRepo,
  AvailabilityRepoService
>() {}

export const AvailabilityRepoLive = Layer.effect(
  AvailabilityRepo,
  Effect.gen(function* () {
    const db = yield* PgDrizzle.PgDrizzle;

    return {
      practitionerIdForUser: (userId) =>
        db
          .select({ id: practitionerProfile.id })
          .from(practitionerProfile)
          .where(eq(practitionerProfile.userId, userId))
          .limit(1)
          .pipe(Effect.map((rows) => rows[0]?.id)),

      overlaps: (practitionerProfileId, startsAt, endsAt) =>
        db
          .select({ id: availabilitySlot.id })
          .from(availabilitySlot)
          .where(
            and(
              eq(availabilitySlot.practitionerProfileId, practitionerProfileId),
              isNull(availabilitySlot.deletedAt),
              // half-open interval intersection: existing.start < new.end AND existing.end > new.start
              lt(availabilitySlot.startsAt, endsAt),
              gt(availabilitySlot.endsAt, startsAt),
            ),
          )
          .limit(1)
          .pipe(Effect.map((rows) => rows.length > 0)),

      insert: (row) =>
        db
          .insert(availabilitySlot)
          .values({
            id: row.id,
            practitionerProfileId: row.practitionerProfileId,
            startsAt: row.startsAt,
            endsAt: row.endsAt,
            consultationTypes: [...row.consultationTypes],
            locationId: row.locationId,
            createdAt: row.createdAt,
            updatedAt: row.updatedAt,
          })
          .returning()
          .pipe(
            Effect.flatMap((rows) =>
              rows[0]
                ? Effect.succeed(toDomain(rows[0]))
                : Effect.dieMessage("Availability slot insert returned no row."),
            ),
          ),
      slotIdExists: (id) =>
        db
          .select({ id: availabilitySlot.id })
          .from(availabilitySlot)
          .where(eq(availabilitySlot.id, id))
          .limit(1)
          .pipe(Effect.map((rows) => rows.length > 0)),

      listByPractitioner: (practitionerProfileId, limit, beforeId) =>
        db
          .select()
          .from(availabilitySlot)
          .where(
            and(
              eq(availabilitySlot.practitionerProfileId, practitionerProfileId),
              isNull(availabilitySlot.deletedAt),
              beforeId === undefined ? undefined : lt(availabilitySlot.id, beforeId),
            ),
          )
          .orderBy(desc(availabilitySlot.id))
          .limit(limit)
          .pipe(Effect.map((rows) => rows.map(toDomain))),

      softDelete: (practitionerProfileId, slotId, deletedAt) =>
        db
          .update(availabilitySlot)
          .set({ deletedAt, updatedAt: deletedAt })
          .where(
            and(
              eq(availabilitySlot.id, slotId),
              eq(availabilitySlot.practitionerProfileId, practitionerProfileId),
              isNull(availabilitySlot.deletedAt),
            ),
          )
          .returning({ id: availabilitySlot.id })
          .pipe(Effect.map((rows) => rows.length > 0)),

      // Keep the open/future/non-deleted rule in sync with the inline subquery in
      // practitioner search.repo.ts (nextAvailableExpr).
      nextAvailableAt: (practitionerProfileId, now) =>
        db
          .select({ startsAt: availabilitySlot.startsAt })
          .from(availabilitySlot)
          .where(
            and(
              eq(availabilitySlot.practitionerProfileId, practitionerProfileId),
              eq(availabilitySlot.status, "open"),
              isNull(availabilitySlot.deletedAt),
              gt(availabilitySlot.startsAt, now),
            ),
          )
          .orderBy(availabilitySlot.startsAt)
          .limit(1)
          .pipe(Effect.map((rows) => rows[0]?.startsAt ?? null)),

      replaceRules: (practitionerProfileId, rows) =>
        db
          .delete(availabilityRule)
          .where(eq(availabilityRule.practitionerProfileId, practitionerProfileId))
          .pipe(
            Effect.flatMap(() =>
              rows.length === 0
                ? Effect.succeed([])
                : db
                    .insert(availabilityRule)
                    .values([...rows])
                    .returning(),
            ),
            Effect.map((created) => created.map(ruleToDomain)),
          ),

      listRules: (practitionerProfileId) =>
        db
          .select()
          .from(availabilityRule)
          .where(eq(availabilityRule.practitionerProfileId, practitionerProfileId))
          .orderBy(asc(availabilityRule.weekday), asc(availabilityRule.startTime))
          .pipe(Effect.map((rows) => rows.map(ruleToDomain))),

      insertException: (row) =>
        db
          .insert(availabilityException)
          .values(row)
          .returning()
          .pipe(
            Effect.flatMap((rows) =>
              rows[0]
                ? Effect.succeed(exceptionToDomain(rows[0]))
                : Effect.dieMessage("Availability exception insert returned no row."),
            ),
          ),
      exceptionIdExists: (id) =>
        db
          .select({ id: availabilityException.id })
          .from(availabilityException)
          .where(eq(availabilityException.id, id))
          .limit(1)
          .pipe(Effect.map((rows) => rows.length > 0)),

      listExceptions: (practitionerProfileId, fromDate, toDate) =>
        db
          .select()
          .from(availabilityException)
          .where(
            and(
              eq(availabilityException.practitionerProfileId, practitionerProfileId),
              gte(availabilityException.date, fromDate),
              lte(availabilityException.date, toDate),
              isNull(availabilityException.deletedAt),
            ),
          )
          .orderBy(asc(availabilityException.date), asc(availabilityException.startTime))
          .pipe(Effect.map((rows) => rows.map(exceptionToDomain))),

      softDeleteException: (practitionerProfileId, id, deletedAt) =>
        db
          .update(availabilityException)
          .set({ deletedAt, updatedAt: deletedAt })
          .where(
            and(
              eq(availabilityException.id, id),
              eq(availabilityException.practitionerProfileId, practitionerProfileId),
              isNull(availabilityException.deletedAt),
            ),
          )
          .returning({ id: availabilityException.id })
          .pipe(Effect.map((rows) => rows.length > 0)),

      listSlotsInRange: (practitionerProfileId, from, to) =>
        db
          .select()
          .from(availabilitySlot)
          .where(
            and(
              eq(availabilitySlot.practitionerProfileId, practitionerProfileId),
              isNull(availabilitySlot.deletedAt),
              lt(availabilitySlot.startsAt, to),
              gt(availabilitySlot.endsAt, from),
            ),
          )
          .orderBy(asc(availabilitySlot.startsAt))
          .pipe(Effect.map((rows) => rows.map(toDomain))),
    } satisfies AvailabilityRepoService;
  }),
);
