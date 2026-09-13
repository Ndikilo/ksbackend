import { SqlError } from "@effect/sql";
import * as PgDrizzle from "@effect/sql-drizzle/Pg";
import { and, type AnyColumn, asc, desc, eq, or, type SQL, sql } from "drizzle-orm";
import { Context, Effect, Layer } from "effect";
import { patientProfile } from "@/db/schema/patient-profile";
import { profile } from "@/db/schema/profile";
import type { PatientCardRow, PatientSearchCriteria, PatientSort } from "@/domain/patient/search";

export type SearchPage = { readonly limit: number; readonly offset: number };
export type SearchResult = { readonly rows: ReadonlyArray<PatientCardRow>; readonly total: number };

export interface PatientSearchRepoService {
  readonly search: (
    criteria: PatientSearchCriteria,
    sort: PatientSort,
    page: SearchPage,
  ) => Effect.Effect<SearchResult, SqlError.SqlError>;
}

export class PatientSearchRepo extends Context.Tag("PatientSearchRepo")<
  PatientSearchRepo,
  PatientSearchRepoService
>() {}

// Typo-tolerant match (ILIKE substring OR pg_trgm word-similarity). See the
// practitioner search repo for the rationale; trigram GIN indexes back it.
const TRGM_THRESHOLD = 0.4;
const fuzzy = (column: AnyColumn, term: string): SQL =>
  sql`(${column} ilike ${`%${term}%`} or word_similarity(${term}, ${column}) >= ${TRGM_THRESHOLD})`;

export const PatientSearchRepoLive = Layer.effect(
  PatientSearchRepo,
  Effect.gen(function* () {
    const db = yield* PgDrizzle.PgDrizzle;

    return {
      search: (criteria, sort, page) => {
        const filters: SQL[] = [];
        if (criteria.q !== undefined) {
          const match = or(
            fuzzy(profile.surname, criteria.q),
            fuzzy(profile.givenNames, criteria.q),
          );
          if (match !== undefined) filters.push(match);
        }

        const dir = sort.direction === "asc" ? asc : desc;
        const orderClauses = {
          name: [dir(profile.surname), dir(profile.givenNames)],
          recency: [dir(patientProfile.createdAt)],
        } satisfies Record<PatientSort["field"], ReadonlyArray<SQL>>;

        const whereClause = filters.length > 0 ? and(...filters) : undefined;
        return db
          .select({
            id: patientProfile.id,
            surname: profile.surname,
            givenNames: profile.givenNames,
            total: sql<number>`(count(*) over ())::int`,
          })
          .from(patientProfile)
          .innerJoin(profile, eq(patientProfile.userId, profile.userId))
          .where(whereClause)
          .orderBy(...orderClauses[sort.field], desc(patientProfile.id))
          .limit(page.limit)
          .offset(page.offset)
          .pipe(
            Effect.flatMap((rows) => {
              const mapped = rows.map((r): PatientCardRow => ({
                id: r.id,
                surname: r.surname,
                givenNames: r.givenNames,
              }));
              const first = rows[0];
              // Empty page → the windowed count has no row to ride on; do a real COUNT.
              if (first !== undefined) {
                return Effect.succeed({ rows: mapped, total: first.total });
              }
              return db
                .select({ total: sql<number>`count(*)::int` })
                .from(patientProfile)
                .innerJoin(profile, eq(patientProfile.userId, profile.userId))
                .where(whereClause)
                .pipe(Effect.map((counted) => ({ rows: mapped, total: counted[0]?.total ?? 0 })));
            }),
          );
      },
    } satisfies PatientSearchRepoService;
  }),
);
