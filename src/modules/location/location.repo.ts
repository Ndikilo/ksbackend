import { SqlError } from "@effect/sql";
import * as PgDrizzle from "@effect/sql-drizzle/Pg";
import { and, asc, desc, eq, isNull, ne } from "drizzle-orm";
import { Context, Effect, Layer } from "effect";
import { practiceLocation } from "@/db/schema/practice-location";
import { availabilityException } from "@/db/schema/availability-exception";
import { availabilityRule } from "@/db/schema/availability-rule";
import { availabilitySlot } from "@/db/schema/availability-slot";
import { practitionerProfile } from "@/db/schema/practitioner-profile";
import type { PracticeLocation, PracticeLocationInput } from "@/domain/location/location";

type Row = typeof practiceLocation.$inferSelect;
const toDomain = (row: Row): PracticeLocation => ({
  ...row,
  consultationTypes: row.consultationTypes,
});
type StoredInput = Omit<PracticeLocationInput, "addressLine2"> & {
  readonly addressLine2: string | null;
  readonly latitude: number | null;
  readonly longitude: number | null;
};

export interface LocationRepoService {
  readonly list: (
    practitionerProfileId: string,
  ) => Effect.Effect<ReadonlyArray<PracticeLocation>, SqlError.SqlError>;
  readonly count: (practitionerProfileId: string) => Effect.Effect<number, SqlError.SqlError>;
  readonly findOwned: (
    practitionerProfileId: string,
    id: string,
  ) => Effect.Effect<PracticeLocation | undefined, SqlError.SqlError>;
  readonly idExists: (id: string) => Effect.Effect<boolean, SqlError.SqlError>;
  readonly isInUse: (id: string) => Effect.Effect<boolean, SqlError.SqlError>;
  readonly insert: (
    row: PracticeLocation & { readonly createdAt: Date; readonly updatedAt: Date },
  ) => Effect.Effect<PracticeLocation, SqlError.SqlError>;
  readonly update: (
    practitionerProfileId: string,
    id: string,
    input: StoredInput,
    updatedAt: Date,
  ) => Effect.Effect<PracticeLocation | undefined, SqlError.SqlError>;
  readonly clearPrimary: (
    practitionerProfileId: string,
    exceptId: string | undefined,
    updatedAt: Date,
  ) => Effect.Effect<void, SqlError.SqlError>;
  readonly syncPrimaryDisplay: (
    practitionerProfileId: string,
    location: PracticeLocation,
    updatedAt: Date,
  ) => Effect.Effect<void, SqlError.SqlError>;
  readonly clearPrimaryDisplay: (
    practitionerProfileId: string,
    updatedAt: Date,
  ) => Effect.Effect<void, SqlError.SqlError>;
  readonly softDelete: (
    practitionerProfileId: string,
    id: string,
    deletedAt: Date,
  ) => Effect.Effect<PracticeLocation | undefined, SqlError.SqlError>;
}

export class LocationRepo extends Context.Tag("LocationRepo")<
  LocationRepo,
  LocationRepoService
>() {}

export const LocationRepoLive = Layer.effect(
  LocationRepo,
  Effect.gen(function* () {
    const db = yield* PgDrizzle.PgDrizzle;
    return {
      list: (practitionerProfileId) =>
        db
          .select()
          .from(practiceLocation)
          .where(
            and(
              eq(practiceLocation.practitionerProfileId, practitionerProfileId),
              isNull(practiceLocation.deletedAt),
            ),
          )
          .orderBy(desc(practiceLocation.isPrimary), asc(practiceLocation.id))
          .pipe(Effect.map((rows) => rows.map(toDomain))),
      count: (practitionerProfileId) =>
        db
          .select({ id: practiceLocation.id })
          .from(practiceLocation)
          .where(
            and(
              eq(practiceLocation.practitionerProfileId, practitionerProfileId),
              isNull(practiceLocation.deletedAt),
            ),
          )
          .pipe(Effect.map((rows) => rows.length)),
      findOwned: (practitionerProfileId, id) =>
        db
          .select()
          .from(practiceLocation)
          .where(
            and(
              eq(practiceLocation.practitionerProfileId, practitionerProfileId),
              eq(practiceLocation.id, id),
              isNull(practiceLocation.deletedAt),
            ),
          )
          .limit(1)
          .pipe(Effect.map((rows) => (rows[0] ? toDomain(rows[0]) : undefined))),
      idExists: (id) =>
        db
          .select({ id: practiceLocation.id })
          .from(practiceLocation)
          .where(eq(practiceLocation.id, id))
          .limit(1)
          .pipe(Effect.map((rows) => rows.length > 0)),
      isInUse: (id) =>
        Effect.all(
          [
            db
              .select({ id: availabilityRule.id })
              .from(availabilityRule)
              .where(eq(availabilityRule.locationId, id))
              .limit(1),
            db
              .select({ id: availabilityException.id })
              .from(availabilityException)
              .where(
                and(
                  eq(availabilityException.locationId, id),
                  isNull(availabilityException.deletedAt),
                ),
              )
              .limit(1),
            db
              .select({ id: availabilitySlot.id })
              .from(availabilitySlot)
              .where(and(eq(availabilitySlot.locationId, id), isNull(availabilitySlot.deletedAt)))
              .limit(1),
          ],
          { concurrency: 3 },
        ).pipe(Effect.map((rows) => rows.some((result) => result.length > 0))),
      insert: (row) =>
        db
          .insert(practiceLocation)
          .values({ ...row, consultationTypes: [...row.consultationTypes] })
          .returning()
          .pipe(
            Effect.flatMap((rows) =>
              rows[0]
                ? Effect.succeed(toDomain(rows[0]))
                : Effect.dieMessage("Practice location insert returned no row."),
            ),
          ),
      update: (practitionerProfileId, id, input, updatedAt) =>
        db
          .update(practiceLocation)
          .set({ ...input, consultationTypes: [...input.consultationTypes], updatedAt })
          .where(
            and(
              eq(practiceLocation.id, id),
              eq(practiceLocation.practitionerProfileId, practitionerProfileId),
              isNull(practiceLocation.deletedAt),
            ),
          )
          .returning()
          .pipe(Effect.map((rows) => (rows[0] ? toDomain(rows[0]) : undefined))),
      clearPrimary: (practitionerProfileId, exceptId, updatedAt) =>
        db
          .update(practiceLocation)
          .set({ isPrimary: false, updatedAt })
          .where(
            and(
              eq(practiceLocation.practitionerProfileId, practitionerProfileId),
              eq(practiceLocation.isPrimary, true),
              isNull(practiceLocation.deletedAt),
              exceptId === undefined ? undefined : ne(practiceLocation.id, exceptId),
            ),
          )
          .pipe(Effect.asVoid),
      syncPrimaryDisplay: (practitionerProfileId, location, updatedAt) =>
        db
          .update(practitionerProfile)
          .set({
            location: [
              location.addressLine1,
              location.city,
              location.region,
              location.country,
            ].join(", "),
            latitude: location.latitude,
            longitude: location.longitude,
            updatedAt,
          })
          .where(eq(practitionerProfile.id, practitionerProfileId))
          .pipe(Effect.asVoid),
      clearPrimaryDisplay: (practitionerProfileId, updatedAt) =>
        db
          .update(practitionerProfile)
          .set({ location: null, latitude: null, longitude: null, updatedAt })
          .where(eq(practitionerProfile.id, practitionerProfileId))
          .pipe(Effect.asVoid),
      softDelete: (practitionerProfileId, id, deletedAt) =>
        db
          .update(practiceLocation)
          .set({ deletedAt, updatedAt: deletedAt })
          .where(
            and(
              eq(practiceLocation.id, id),
              eq(practiceLocation.practitionerProfileId, practitionerProfileId),
              isNull(practiceLocation.deletedAt),
            ),
          )
          .returning()
          .pipe(Effect.map((rows) => (rows[0] ? toDomain(rows[0]) : undefined))),
    } satisfies LocationRepoService;
  }),
);
