import { SqlClient, SqlError } from "@effect/sql";
import * as PgDrizzle from "@effect/sql-drizzle/Pg";
import { and, count, desc, eq, isNull, lt } from "drizzle-orm";
import { Context, Effect, Layer } from "effect";
import { caregiverLink } from "@/db/schema/caregiver-link";
import { dependent } from "@/db/schema/dependent";
import type { Dependent, DependentInput, DependentPatch } from "@/domain/dependent/dependent";

type DependentRow = typeof dependent.$inferSelect;
type LinkRow = typeof caregiverLink.$inferSelect;

const toDomain = (d: DependentRow, link: LinkRow): Dependent => ({
  id: d.id,
  surname: d.surname,
  givenNames: d.givenNames,
  dateOfBirth: d.dateOfBirth,
  sex: d.sex,
  relationship: link.relationship,
  phone: d.phone,
  location: d.location,
});

export interface DependentRepoService {
  readonly create: (input: {
    readonly caregiverId: string;
    readonly dependentId: string;
    readonly linkId: string;
    readonly values: DependentInput;
    readonly now: Date;
  }) => Effect.Effect<Dependent, SqlError.SqlError>;
  readonly listByCaregiver: (
    caregiverId: string,
    limit: number,
    beforeId: string | undefined,
  ) => Effect.Effect<ReadonlyArray<Dependent>, SqlError.SqlError>;
  readonly findForCaregiver: (
    caregiverId: string,
    id: string,
  ) => Effect.Effect<Dependent | undefined, SqlError.SqlError>;
  readonly update: (
    caregiverId: string,
    id: string,
    patch: DependentPatch,
    now: Date,
  ) => Effect.Effect<Dependent | undefined, SqlError.SqlError>;
  /** Remove this caregiver's link; soft-delete the dependent if it was the last. */
  readonly unlink: (
    caregiverId: string,
    id: string,
    now: Date,
  ) => Effect.Effect<boolean, SqlError.SqlError>;
}

export class DependentRepo extends Context.Tag("DependentRepo")<
  DependentRepo,
  DependentRepoService
>() {}

// An active managed link owned by this caregiver, to a non-deleted dependent.
const ownedLink = (caregiverId: string, dependentId: string) =>
  and(
    eq(caregiverLink.caregiverUserId, caregiverId),
    eq(caregiverLink.managedDependentId, dependentId),
    eq(caregiverLink.status, "active"),
    isNull(dependent.deletedAt),
  );

export const DependentRepoLive = Layer.effect(
  DependentRepo,
  Effect.gen(function* () {
    const db = yield* PgDrizzle.PgDrizzle;
    const sql = yield* SqlClient.SqlClient;

    const findForCaregiver = (caregiverId: string, id: string) =>
      db
        .select({ dependent, link: caregiverLink })
        .from(caregiverLink)
        .innerJoin(dependent, eq(caregiverLink.managedDependentId, dependent.id))
        .where(ownedLink(caregiverId, id))
        .limit(1)
        .pipe(
          Effect.map((rows) => (rows[0] ? toDomain(rows[0].dependent, rows[0].link) : undefined)),
        );

    return {
      create: ({ caregiverId, dependentId, linkId, values, now }) =>
        sql
          .withTransaction(
            Effect.gen(function* () {
              yield* db.insert(dependent).values({
                id: dependentId,
                surname: values.surname,
                givenNames: values.givenNames,
                dateOfBirth: values.dateOfBirth,
                sex: values.sex,
                phone: values.phone ?? null,
                location: values.location ?? null,
              });
              yield* db.insert(caregiverLink).values({
                id: linkId,
                caregiverUserId: caregiverId,
                managedDependentId: dependentId,
                relationship: values.relationship,
                status: "active",
                createdAt: now,
                updatedAt: now,
              });
            }),
          )
          .pipe(
            Effect.flatMap(() => findForCaregiver(caregiverId, dependentId)),
            Effect.flatMap((found) =>
              found ? Effect.succeed(found) : Effect.dieMessage("dependent missing after create"),
            ),
          ),

      listByCaregiver: (caregiverId, limit, beforeId) =>
        db
          .select({ dependent, link: caregiverLink })
          .from(caregiverLink)
          .innerJoin(dependent, eq(caregiverLink.managedDependentId, dependent.id))
          .where(
            beforeId === undefined
              ? and(
                  eq(caregiverLink.caregiverUserId, caregiverId),
                  eq(caregiverLink.status, "active"),
                  isNull(dependent.deletedAt),
                )
              : and(
                  eq(caregiverLink.caregiverUserId, caregiverId),
                  eq(caregiverLink.status, "active"),
                  isNull(dependent.deletedAt),
                  lt(dependent.id, beforeId),
                ),
          )
          .orderBy(desc(dependent.id))
          .limit(limit)
          .pipe(Effect.map((rows) => rows.map((r) => toDomain(r.dependent, r.link)))),

      findForCaregiver,

      update: (caregiverId, id, patch, now) =>
        Effect.gen(function* () {
          // Only proceed if this caregiver actually owns an active link.
          const existing = yield* findForCaregiver(caregiverId, id);
          if (existing === undefined) return undefined;
          yield* sql.withTransaction(
            Effect.gen(function* () {
              const personFields = {
                ...(patch.surname !== undefined && { surname: patch.surname }),
                ...(patch.givenNames !== undefined && { givenNames: patch.givenNames }),
                ...(patch.dateOfBirth !== undefined && { dateOfBirth: patch.dateOfBirth }),
                ...(patch.sex !== undefined && { sex: patch.sex }),
                ...(patch.phone !== undefined && { phone: patch.phone }),
                ...(patch.location !== undefined && { location: patch.location }),
              };
              if (Object.keys(personFields).length > 0) {
                yield* db
                  .update(dependent)
                  .set({ ...personFields, updatedAt: now })
                  .where(eq(dependent.id, id));
              }
              // relationship is per-caregiver → it lives on this caregiver's link.
              if (patch.relationship !== undefined) {
                yield* db
                  .update(caregiverLink)
                  .set({ relationship: patch.relationship, updatedAt: now })
                  .where(
                    and(
                      eq(caregiverLink.caregiverUserId, caregiverId),
                      eq(caregiverLink.managedDependentId, id),
                      eq(caregiverLink.status, "active"),
                    ),
                  );
              }
            }),
          );
          return yield* findForCaregiver(caregiverId, id);
        }),

      unlink: (caregiverId, id, now) =>
        Effect.gen(function* () {
          const existing = yield* findForCaregiver(caregiverId, id);
          if (existing === undefined) return false;
          yield* sql.withTransaction(
            Effect.gen(function* () {
              yield* db
                .delete(caregiverLink)
                .where(
                  and(
                    eq(caregiverLink.caregiverUserId, caregiverId),
                    eq(caregiverLink.managedDependentId, id),
                  ),
                );
              // Last caregiver gone → soft-delete the orphaned dependent.
              const remaining = yield* db
                .select({ n: count() })
                .from(caregiverLink)
                .where(eq(caregiverLink.managedDependentId, id));
              if ((remaining[0]?.n ?? 0) === 0) {
                yield* db.update(dependent).set({ deletedAt: now }).where(eq(dependent.id, id));
              }
            }),
          );
          return true;
        }),
    } satisfies DependentRepoService;
  }),
);
