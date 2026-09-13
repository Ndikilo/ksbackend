import { SqlError } from "@effect/sql";
import * as PgDrizzle from "@effect/sql-drizzle/Pg";
import { and, asc, eq, isNull, min, ne } from "drizzle-orm";
import { Context, Effect, Layer } from "effect";
import { consultationOffering } from "@/db/schema/consultation-offering";
import { practitionerProfile } from "@/db/schema/practitioner-profile";
import type { ConsultationOffering, ConsultationOfferingPatch } from "@/domain/offering/offering";

type Row = typeof consultationOffering.$inferSelect;
const toDomain = (row: Row): ConsultationOffering => ({
  id: row.id,
  practitionerProfileId: row.practitionerProfileId,
  consultationType: row.consultationType,
  durationMin: row.durationMin,
  priceXaf: row.priceXaf,
  active: row.active,
});
export interface OfferingRepoService {
  readonly list: (
    practitionerProfileId: string,
    activeOnly: boolean,
  ) => Effect.Effect<ReadonlyArray<ConsultationOffering>, SqlError.SqlError>;
  readonly insert: (
    row: ConsultationOffering & { readonly createdAt: Date; readonly updatedAt: Date },
  ) => Effect.Effect<ConsultationOffering, SqlError.SqlError>;
  readonly findOwned: (
    practitionerProfileId: string,
    id: string,
  ) => Effect.Effect<ConsultationOffering | undefined, SqlError.SqlError>;
  readonly idExists: (id: string) => Effect.Effect<boolean, SqlError.SqlError>;
  readonly hasDuplicate: (
    practitionerProfileId: string,
    consultationType: ConsultationOffering["consultationType"],
    durationMin: number,
    exceptId: string | undefined,
  ) => Effect.Effect<boolean, SqlError.SqlError>;
  readonly update: (
    practitionerProfileId: string,
    id: string,
    input: ConsultationOfferingPatch,
    updatedAt: Date,
  ) => Effect.Effect<ConsultationOffering | undefined, SqlError.SqlError>;
  readonly softDelete: (
    practitionerProfileId: string,
    id: string,
    deletedAt: Date,
  ) => Effect.Effect<boolean, SqlError.SqlError>;
  readonly syncMinimumFee: (
    practitionerProfileId: string,
    updatedAt: Date,
  ) => Effect.Effect<void, SqlError.SqlError>;
}
export class OfferingRepo extends Context.Tag("OfferingRepo")<
  OfferingRepo,
  OfferingRepoService
>() {}
export const OfferingRepoLive = Layer.effect(
  OfferingRepo,
  Effect.gen(function* () {
    const db = yield* PgDrizzle.PgDrizzle;
    return {
      list: (practitionerProfileId, activeOnly) =>
        db
          .select()
          .from(consultationOffering)
          .where(
            and(
              eq(consultationOffering.practitionerProfileId, practitionerProfileId),
              isNull(consultationOffering.deletedAt),
              activeOnly ? eq(consultationOffering.active, true) : undefined,
            ),
          )
          .orderBy(asc(consultationOffering.priceXaf), asc(consultationOffering.durationMin))
          .pipe(Effect.map((rows) => rows.map(toDomain))),
      insert: (row) =>
        db
          .insert(consultationOffering)
          .values(row)
          .returning()
          .pipe(
            Effect.flatMap((rows) =>
              rows[0]
                ? Effect.succeed(toDomain(rows[0]))
                : Effect.dieMessage("Consultation offering insert returned no row."),
            ),
          ),
      findOwned: (practitionerProfileId, id) =>
        db
          .select()
          .from(consultationOffering)
          .where(
            and(
              eq(consultationOffering.practitionerProfileId, practitionerProfileId),
              eq(consultationOffering.id, id),
              isNull(consultationOffering.deletedAt),
            ),
          )
          .limit(1)
          .pipe(Effect.map((rows) => (rows[0] ? toDomain(rows[0]) : undefined))),
      idExists: (id) =>
        db
          .select({ id: consultationOffering.id })
          .from(consultationOffering)
          .where(eq(consultationOffering.id, id))
          .limit(1)
          .pipe(Effect.map((rows) => rows.length > 0)),
      hasDuplicate: (practitionerProfileId, consultationType, durationMin, exceptId) =>
        db
          .select({ id: consultationOffering.id })
          .from(consultationOffering)
          .where(
            and(
              eq(consultationOffering.practitionerProfileId, practitionerProfileId),
              eq(consultationOffering.consultationType, consultationType),
              eq(consultationOffering.durationMin, durationMin),
              isNull(consultationOffering.deletedAt),
              exceptId === undefined ? undefined : ne(consultationOffering.id, exceptId),
            ),
          )
          .limit(1)
          .pipe(Effect.map((rows) => rows.length > 0)),
      update: (practitionerProfileId, id, input, updatedAt) =>
        db
          .update(consultationOffering)
          .set({ ...input, updatedAt })
          .where(
            and(
              eq(consultationOffering.id, id),
              eq(consultationOffering.practitionerProfileId, practitionerProfileId),
              isNull(consultationOffering.deletedAt),
            ),
          )
          .returning()
          .pipe(Effect.map((rows) => (rows[0] ? toDomain(rows[0]) : undefined))),
      softDelete: (practitionerProfileId, id, deletedAt) =>
        db
          .update(consultationOffering)
          .set({ deletedAt, active: false, updatedAt: deletedAt })
          .where(
            and(
              eq(consultationOffering.id, id),
              eq(consultationOffering.practitionerProfileId, practitionerProfileId),
              isNull(consultationOffering.deletedAt),
            ),
          )
          .returning({ id: consultationOffering.id })
          .pipe(Effect.map((rows) => rows.length > 0)),
      syncMinimumFee: (practitionerProfileId, updatedAt) =>
        db
          .select({ fee: min(consultationOffering.priceXaf) })
          .from(consultationOffering)
          .where(
            and(
              eq(consultationOffering.practitionerProfileId, practitionerProfileId),
              eq(consultationOffering.active, true),
              isNull(consultationOffering.deletedAt),
            ),
          )
          .pipe(
            Effect.flatMap((rows) =>
              db
                .update(practitionerProfile)
                .set({ consultationFeeXaf: rows[0]?.fee ?? null, updatedAt })
                .where(eq(practitionerProfile.id, practitionerProfileId)),
            ),
            Effect.asVoid,
          ),
    } satisfies OfferingRepoService;
  }),
);
