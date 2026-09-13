import { SqlError } from "@effect/sql";
import * as PgDrizzle from "@effect/sql-drizzle/Pg";
import { and, asc, desc, eq, gt, isNull, lt, or, sql } from "drizzle-orm";
import { Context, Effect, Layer } from "effect";
import { practitionerProfile } from "@/db/schema/practitioner-profile";
import { profile } from "@/db/schema/profile";
import { review } from "@/db/schema/review";
import type { Review, ReviewSort, ReviewSummary } from "@/domain/review/review";

type Row = typeof review.$inferSelect;

export type NewReviewRow = {
  readonly id: string;
  readonly practitionerProfileId: string;
  readonly reviewerUserId: string;
  readonly rating: number;
  readonly comment: string | null;
  readonly createdAt: Date;
  readonly updatedAt: Date;
};

export type ReviewCursor = {
  readonly id: string;
  readonly rating: number;
};

const displayName = (givenNames: string | null, surname: string | null): string | null => {
  if (givenNames === null) return null;
  const initial = surname?.trim().charAt(0);
  return initial ? `${givenNames} ${initial}.` : givenNames;
};

const toDomain = (r: Row, reviewerName: string | null): Review => ({
  id: r.id,
  practitionerProfileId: r.practitionerProfileId,
  reviewerUserId: r.reviewerUserId,
  reviewerName,
  verifiedAppointment: false,
  rating: r.rating,
  comment: r.comment,
  createdAt: r.createdAt,
  updatedAt: r.updatedAt,
});

export interface ReviewRepoService {
  readonly findActiveByPair: (
    reviewerUserId: string,
    practitionerProfileId: string,
  ) => Effect.Effect<Review | undefined, SqlError.SqlError>;
  readonly insert: (row: NewReviewRow) => Effect.Effect<void, SqlError.SqlError>;
  readonly update: (
    id: string,
    patch: { readonly rating: number; readonly comment: string | null; readonly updatedAt: Date },
  ) => Effect.Effect<void, SqlError.SqlError>;
  readonly softDelete: (id: string, deletedAt: Date) => Effect.Effect<void, SqlError.SqlError>;
  readonly listByPractitioner: (
    practitionerProfileId: string,
    limit: number,
    cursor: ReviewCursor | undefined,
    rating: number | undefined,
    sort: ReviewSort,
  ) => Effect.Effect<ReadonlyArray<Review>, SqlError.SqlError>;
  readonly summary: (
    practitionerProfileId: string,
  ) => Effect.Effect<ReviewSummary, SqlError.SqlError>;
  /** Recompute the denormalized rating aggregate on practitioner_profile from active rows. */
  readonly recomputeRating: (
    practitionerProfileId: string,
    now: Date,
  ) => Effect.Effect<void, SqlError.SqlError>;
}

export class ReviewRepo extends Context.Tag("ReviewRepo")<ReviewRepo, ReviewRepoService>() {}

export const ReviewRepoLive = Layer.effect(
  ReviewRepo,
  Effect.gen(function* () {
    const db = yield* PgDrizzle.PgDrizzle;

    const joined = () =>
      db
        .select({
          review,
          reviewerGivenNames: profile.givenNames,
          reviewerSurname: profile.surname,
        })
        .from(review)
        .leftJoin(profile, eq(profile.userId, review.reviewerUserId));

    return {
      findActiveByPair: (reviewerUserId, practitionerProfileId) =>
        joined()
          .where(
            and(
              eq(review.reviewerUserId, reviewerUserId),
              eq(review.practitionerProfileId, practitionerProfileId),
              isNull(review.deletedAt),
            ),
          )
          .limit(1)
          .pipe(
            Effect.map((rows) =>
              rows[0]
                ? toDomain(
                    rows[0].review,
                    displayName(rows[0].reviewerGivenNames, rows[0].reviewerSurname),
                  )
                : undefined,
            ),
          ),

      insert: (row) =>
        db
          .insert(review)
          .values({
            id: row.id,
            practitionerProfileId: row.practitionerProfileId,
            reviewerUserId: row.reviewerUserId,
            rating: row.rating,
            comment: row.comment,
            createdAt: row.createdAt,
            updatedAt: row.updatedAt,
          })
          .pipe(Effect.asVoid),

      update: (id, patch) =>
        db
          .update(review)
          .set({ rating: patch.rating, comment: patch.comment, updatedAt: patch.updatedAt })
          .where(eq(review.id, id))
          .pipe(Effect.asVoid),

      softDelete: (id, deletedAt) =>
        db.update(review).set({ deletedAt }).where(eq(review.id, id)).pipe(Effect.asVoid),

      listByPractitioner: (practitionerProfileId, limit, cursor, rating, sort) =>
        joined()
          .where(
            and(
              eq(review.practitionerProfileId, practitionerProfileId),
              isNull(review.deletedAt),
              rating === undefined ? undefined : eq(review.rating, rating),
              cursor === undefined
                ? undefined
                : sort === "newest"
                  ? lt(review.id, cursor.id)
                  : sort === "highest"
                    ? or(
                        lt(review.rating, cursor.rating),
                        and(eq(review.rating, cursor.rating), lt(review.id, cursor.id)),
                      )
                    : or(
                        gt(review.rating, cursor.rating),
                        and(eq(review.rating, cursor.rating), lt(review.id, cursor.id)),
                      ),
            ),
          )
          .orderBy(
            sort === "highest"
              ? desc(review.rating)
              : sort === "lowest"
                ? asc(review.rating)
                : desc(review.id),
            desc(review.id),
          )
          .limit(limit)
          .pipe(
            Effect.map((rows) =>
              rows.map((r) =>
                toDomain(r.review, displayName(r.reviewerGivenNames, r.reviewerSurname)),
              ),
            ),
          ),

      summary: (practitionerProfileId) =>
        db
          .select({ rating: review.rating, count: sql<number>`count(*)::int` })
          .from(review)
          .where(
            and(eq(review.practitionerProfileId, practitionerProfileId), isNull(review.deletedAt)),
          )
          .groupBy(review.rating)
          .pipe(
            Effect.map((rows) => {
              const distribution = { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0 };
              let weighted = 0;
              let count = 0;
              for (const row of rows) {
                switch (row.rating) {
                  case 1:
                    distribution[1] = row.count;
                    break;
                  case 2:
                    distribution[2] = row.count;
                    break;
                  case 3:
                    distribution[3] = row.count;
                    break;
                  case 4:
                    distribution[4] = row.count;
                    break;
                  case 5:
                    distribution[5] = row.count;
                    break;
                }
                if (row.rating >= 1 && row.rating <= 5) {
                  weighted += row.rating * row.count;
                  count += row.count;
                }
              }
              return {
                average: count === 0 ? 0 : Math.round((weighted / count) * 100) / 100,
                count,
                distribution,
              };
            }),
          ),

      recomputeRating: (practitionerProfileId, now) =>
        db
          .update(practitionerProfile)
          .set({
            ratingAverage: sql`coalesce((select round(avg(${review.rating})::numeric, 2) from ${review} where ${review.practitionerProfileId} = ${practitionerProfileId} and ${review.deletedAt} is null), 0)`,
            ratingCount: sql`(select count(*)::int from ${review} where ${review.practitionerProfileId} = ${practitionerProfileId} and ${review.deletedAt} is null)`,
            updatedAt: now,
          })
          .where(eq(practitionerProfile.id, practitionerProfileId))
          .pipe(Effect.asVoid),
    } satisfies ReviewRepoService;
  }),
);
