import { SqlError } from "@effect/sql";
import * as PgDrizzle from "@effect/sql-drizzle/Pg";
import { and, asc, eq, isNull } from "drizzle-orm";
import { Context, Effect, Layer } from "effect";
import { practitionerQualification } from "@/db/schema/practitioner-qualification";
import type { Qualification, QualificationPatch } from "@/domain/qualification/qualification";

type Row = typeof practitionerQualification.$inferSelect;

const toDomain = (row: Row): Qualification => ({
  id: row.id,
  practitionerProfileId: row.practitionerProfileId,
  kind: row.kind,
  title: row.title,
  institution: row.institution,
  country: row.country,
  year: row.year,
  sortOrder: row.sortOrder,
  verifiedAt: row.verifiedAt,
});

export interface QualificationRepoService {
  readonly list: (
    practitionerProfileId: string,
  ) => Effect.Effect<ReadonlyArray<Qualification>, SqlError.SqlError>;
  readonly count: (practitionerProfileId: string) => Effect.Effect<number, SqlError.SqlError>;
  readonly idExists: (id: string) => Effect.Effect<boolean, SqlError.SqlError>;
  readonly insert: (
    row: Qualification & { readonly createdAt: Date; readonly updatedAt: Date },
  ) => Effect.Effect<Qualification, SqlError.SqlError>;
  readonly update: (
    practitionerProfileId: string,
    id: string,
    input: QualificationPatch,
    updatedAt: Date,
  ) => Effect.Effect<Qualification | undefined, SqlError.SqlError>;
  readonly softDelete: (
    practitionerProfileId: string,
    id: string,
    deletedAt: Date,
  ) => Effect.Effect<boolean, SqlError.SqlError>;
}

export class QualificationRepo extends Context.Tag("QualificationRepo")<
  QualificationRepo,
  QualificationRepoService
>() {}

export const QualificationRepoLive = Layer.effect(
  QualificationRepo,
  Effect.gen(function* () {
    const db = yield* PgDrizzle.PgDrizzle;
    return {
      list: (practitionerProfileId) =>
        db
          .select()
          .from(practitionerQualification)
          .where(
            and(
              eq(practitionerQualification.practitionerProfileId, practitionerProfileId),
              isNull(practitionerQualification.deletedAt),
            ),
          )
          .orderBy(asc(practitionerQualification.sortOrder), asc(practitionerQualification.id))
          .pipe(Effect.map((rows) => rows.map(toDomain))),
      count: (practitionerProfileId) =>
        db
          .select({ id: practitionerQualification.id })
          .from(practitionerQualification)
          .where(
            and(
              eq(practitionerQualification.practitionerProfileId, practitionerProfileId),
              isNull(practitionerQualification.deletedAt),
            ),
          )
          .pipe(Effect.map((rows) => rows.length)),
      idExists: (id) =>
        db
          .select({ id: practitionerQualification.id })
          .from(practitionerQualification)
          .where(eq(practitionerQualification.id, id))
          .limit(1)
          .pipe(Effect.map((rows) => rows.length > 0)),
      insert: (row) =>
        db
          .insert(practitionerQualification)
          .values(row)
          .returning()
          .pipe(
            Effect.flatMap((rows) =>
              rows[0]
                ? Effect.succeed(toDomain(rows[0]))
                : Effect.dieMessage("Qualification insert returned no row."),
            ),
          ),
      update: (practitionerProfileId, id, input, updatedAt) =>
        db
          .update(practitionerQualification)
          .set({ ...input, updatedAt })
          .where(
            and(
              eq(practitionerQualification.id, id),
              eq(practitionerQualification.practitionerProfileId, practitionerProfileId),
              isNull(practitionerQualification.deletedAt),
            ),
          )
          .returning()
          .pipe(Effect.map((rows) => (rows[0] ? toDomain(rows[0]) : undefined))),
      softDelete: (practitionerProfileId, id, deletedAt) =>
        db
          .update(practitionerQualification)
          .set({ deletedAt, updatedAt: deletedAt })
          .where(
            and(
              eq(practitionerQualification.id, id),
              eq(practitionerQualification.practitionerProfileId, practitionerProfileId),
              isNull(practitionerQualification.deletedAt),
            ),
          )
          .returning({ id: practitionerQualification.id })
          .pipe(Effect.map((rows) => rows.length > 0)),
    } satisfies QualificationRepoService;
  }),
);
