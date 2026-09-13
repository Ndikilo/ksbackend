import { SqlError } from "@effect/sql";
import * as PgDrizzle from "@effect/sql-drizzle/Pg";
import {
  and,
  type AnyColumn,
  arrayContains,
  arrayOverlaps,
  asc,
  desc,
  eq,
  gte,
  lte,
  or,
  type SQL,
  sql,
} from "drizzle-orm";
import { Context, Effect, Layer } from "effect";
import { availabilitySlot } from "@/db/schema/availability-slot";
import { practitionerProfile } from "@/db/schema/practitioner-profile";
import { profession } from "@/db/schema/profession";
import { profile } from "@/db/schema/profile";
import type {
  PractitionerCardRow,
  PractitionerSearchCriteria,
  PractitionerSort,
} from "@/domain/practitioner/search";

export type SearchPage = { readonly limit: number; readonly offset: number };
export type SearchResult = {
  readonly rows: ReadonlyArray<PractitionerCardRow>;
  readonly total: number;
};

export interface PractitionerSearchRepoService {
  readonly search: (
    criteria: PractitionerSearchCriteria,
    sort: PractitionerSort,
    page: SearchPage,
    now: Date,
  ) => Effect.Effect<SearchResult, SqlError.SqlError>;
}

export class PractitionerSearchRepo extends Context.Tag("PractitionerSearchRepo")<
  PractitionerSearchRepo,
  PractitionerSearchRepoService
>() {}

const like = (value: string): string => `%${value}%`;

// Minimum pg_trgm word-similarity for a fuzzy text hit — high enough that genuine
// typos match ("cardiollogy" ≈ "cardiology" ≈ 0.7) but distinct words with a shared
// suffix do not ("dermatology" vs "cardiology" ≈ 0.25). Tunable.
const TRGM_THRESHOLD = 0.4;

/**
 * Typo-tolerant text match: an exact substring (ILIKE) OR a trigram
 * word-similarity hit (pg_trgm). `word_similarity(term, col)` scores the query
 * against the best-matching run of words in the column, so "cardiollogy" still
 * finds "Cardiology" and "Nkemtajii" finds "Nkemtaji". Null columns → no match.
 */
const fuzzy = (column: AnyColumn, term: string): SQL =>
  sql`(${column} ilike ${like(term)} or word_similarity(${term}, ${column}) >= ${TRGM_THRESHOLD})`;

export const PractitionerSearchRepoLive = Layer.effect(
  PractitionerSearchRepo,
  Effect.gen(function* () {
    const db = yield* PgDrizzle.PgDrizzle;

    return {
      search: (criteria, sort, page, now) => {
        // The soonest open, future, non-deleted slot for each row (NULL if none).
        // Keep the open/future/non-deleted rule in sync with AvailabilityRepo.nextAvailableAt.
        const nextAvailableExpr = sql<Date | null>`(
          select min(${availabilitySlot.startsAt})
          from ${availabilitySlot}
          where ${availabilitySlot.practitionerProfileId} = ${practitionerProfile.id}
            and ${availabilitySlot.status} = 'open'
            and ${availabilitySlot.deletedAt} is null
            and ${availabilitySlot.startsAt} > ${now}
        )`;

        // Haversine distance (km) from the searcher; NULL when either side lacks coords.
        const origin = criteria.origin;
        const distanceExpr =
          origin === undefined
            ? sql<number | null>`null`
            : sql<number | null>`(6371 * acos(least(1, greatest(-1,
                cos(radians(${origin.latitude})) * cos(radians(${practitionerProfile.latitude}))
                * cos(radians(${practitionerProfile.longitude}) - radians(${origin.longitude}))
                + sin(radians(${origin.latitude})) * sin(radians(${practitionerProfile.latitude}))
              ))))`;

        const filters: SQL[] = [
          eq(practitionerProfile.verificationStatus, "verified"),
          eq(profession.active, true),
        ];
        if (criteria.specialty !== undefined) {
          filters.push(fuzzy(practitionerProfile.specialty, criteria.specialty));
        }
        if (criteria.city !== undefined) {
          filters.push(fuzzy(practitionerProfile.location, criteria.city));
        }
        if (criteria.language !== undefined) {
          filters.push(arrayContains(practitionerProfile.languagesSpoken, [criteria.language]));
        }
        if (criteria.consultationTypes !== undefined && criteria.consultationTypes.length > 0) {
          filters.push(
            arrayOverlaps(practitionerProfile.consultationTypes, [...criteria.consultationTypes]),
          );
        }
        if (criteria.feeMin !== undefined) {
          filters.push(gte(practitionerProfile.consultationFeeXaf, criteria.feeMin));
        }
        if (criteria.feeMax !== undefined) {
          filters.push(lte(practitionerProfile.consultationFeeXaf, criteria.feeMax));
        }
        if (criteria.professionId !== undefined) {
          filters.push(eq(practitionerProfile.professionId, criteria.professionId));
        }
        if (criteria.q !== undefined) {
          const match = or(
            fuzzy(profile.surname, criteria.q),
            fuzzy(profile.givenNames, criteria.q),
            fuzzy(practitionerProfile.specialty, criteria.q),
            fuzzy(practitionerProfile.location, criteria.q),
          );
          if (match !== undefined) filters.push(match);
        }

        const dir = sort.direction === "asc" ? asc : desc;
        const dirSql = sort.direction === "asc" ? sql`asc` : sql`desc`;
        const orderClauses = {
          fee: [dir(practitionerProfile.consultationFeeXaf)],
          experience: [dir(practitionerProfile.yearsExperience)],
          rating: [dir(practitionerProfile.ratingAverage), dir(practitionerProfile.ratingCount)],
          name: [dir(profile.surname), dir(profile.givenNames)],
          recency: [dir(practitionerProfile.createdAt)],
          availability: [sql`${nextAvailableExpr} ${dirSql} nulls last`],
          distance: [sql`${distanceExpr} ${dirSql} nulls last`],
        } satisfies Record<PractitionerSort["field"], ReadonlyArray<SQL>>;

        return db
          .select({
            id: practitionerProfile.id,
            professionId: practitionerProfile.professionId,
            professionNameEn: profession.nameEn,
            professionNameFr: profession.nameFr,
            professionPrefixHint: profession.prefixHint,
            prefix: practitionerProfile.prefix,
            surname: profile.surname,
            givenNames: profile.givenNames,
            specialty: practitionerProfile.specialty,
            location: practitionerProfile.location,
            consultationTypes: practitionerProfile.consultationTypes,
            languagesSpoken: practitionerProfile.languagesSpoken,
            consultationFeeXaf: practitionerProfile.consultationFeeXaf,
            ratingAverage: practitionerProfile.ratingAverage,
            ratingCount: practitionerProfile.ratingCount,
            nextAvailableAt: nextAvailableExpr,
            distanceKm: distanceExpr,
            profilePhotoFileKey: practitionerProfile.profilePhotoFileKey,
            total: sql<number>`(count(*) over ())::int`,
          })
          .from(practitionerProfile)
          .innerJoin(profile, eq(practitionerProfile.userId, profile.userId))
          .innerJoin(profession, eq(practitionerProfile.professionId, profession.id))
          .where(and(...filters))
          .orderBy(...orderClauses[sort.field], desc(practitionerProfile.id))
          .limit(page.limit)
          .offset(page.offset)
          .pipe(
            Effect.flatMap((rows) => {
              const mapped = rows.map((r): PractitionerCardRow => ({
                id: r.id,
                professionId: r.professionId,
                professionNameEn: r.professionNameEn,
                professionNameFr: r.professionNameFr,
                professionPrefixHint: r.professionPrefixHint,
                prefix: r.prefix,
                surname: r.surname,
                givenNames: r.givenNames,
                specialty: r.specialty,
                location: r.location,
                consultationTypes: r.consultationTypes,
                languagesSpoken: r.languagesSpoken,
                consultationFeeXaf: r.consultationFeeXaf,
                ratingAverage: r.ratingAverage,
                ratingCount: r.ratingCount,
                nextAvailableAt: r.nextAvailableAt,
                distanceKm: r.distanceKm,
                profilePhotoFileKey: r.profilePhotoFileKey,
              }));
              const first = rows[0];
              // `count(*) over ()` rides on the returned rows, so a page past the last match
              // (empty result) can't carry the total — fall back to a dedicated COUNT there.
              if (first !== undefined) {
                return Effect.succeed({ rows: mapped, total: first.total });
              }
              return db
                .select({ total: sql<number>`count(*)::int` })
                .from(practitionerProfile)
                .innerJoin(profile, eq(practitionerProfile.userId, profile.userId))
                .innerJoin(profession, eq(practitionerProfile.professionId, profession.id))
                .where(and(...filters))
                .pipe(Effect.map((counted) => ({ rows: mapped, total: counted[0]?.total ?? 0 })));
            }),
          );
      },
    } satisfies PractitionerSearchRepoService;
  }),
);
