import { SqlClient, SqlError } from "@effect/sql";
import { Clock, Context, Effect, Layer } from "effect";
import { ReviewNotEligible } from "@/domain/review/errors";
import type { Review, ReviewInput, ReviewSort, ReviewSummary } from "@/domain/review/review";
import { Forbidden, NotFound, ValidationFailed } from "@/domain/shared/errors";
import { CurrentUser } from "@/infra/auth";
import { requireRole } from "@/infra/authz";
import { IdGenerator } from "@/infra/ids";
import { decodeCursor, encodeCursor } from "@/lib/cursor";
import { PractitionerRepo } from "@/modules/practitioner/practitioner.repo";
import { ReviewRepo, type ReviewCursor } from "./review.repo";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const encodeReviewCursor = (review: Review): string =>
  encodeCursor(`${review.rating}:${review.id}`);
const decodeReviewCursor = (cursor: string): ReviewCursor | undefined => {
  const [rawRating, id, ...rest] = decodeCursor(cursor).split(":");
  const rating = Number(rawRating);
  return rest.length === 0 && id !== undefined && UUID_RE.test(id) && rating >= 1 && rating <= 5
    ? { id, rating }
    : undefined;
};

// Appointment creation is deliberately a later story. The API owns this rule now:
// until a completed appointment can be found, nobody is eligible to write a review.
const assertCanReview = (practitionerProfileId: string) =>
  requireRole("patient").pipe(
    Effect.zipRight(Effect.fail(new ReviewNotEligible({ practitionerProfileId }))),
  );

export type ReviewPage = {
  readonly data: ReadonlyArray<Review>;
  readonly meta: {
    readonly count: number;
    readonly limit: number;
    readonly nextCursor: string | null;
    readonly hasNextPage: boolean;
  };
};

export interface ReviewServiceService {
  readonly upsertReview: (
    reviewerUserId: string,
    practitionerProfileId: string,
    input: ReviewInput,
  ) => Effect.Effect<
    { readonly review: Review; readonly created: boolean },
    Forbidden | ReviewNotEligible | NotFound | SqlError.SqlError,
    CurrentUser
  >;
  readonly deleteOwnReview: (
    reviewerUserId: string,
    practitionerProfileId: string,
  ) => Effect.Effect<void, NotFound | SqlError.SqlError>;
  readonly listReviews: (
    practitionerProfileId: string,
    limit: number,
    cursor: string | undefined,
    rating: number | undefined,
    sort: ReviewSort,
  ) => Effect.Effect<ReviewPage, NotFound | ValidationFailed | SqlError.SqlError>;
  readonly getOwnReview: (
    reviewerUserId: string,
    practitionerProfileId: string,
  ) => Effect.Effect<Review, NotFound | SqlError.SqlError>;
  readonly summary: (
    practitionerProfileId: string,
  ) => Effect.Effect<ReviewSummary, NotFound | SqlError.SqlError>;
  readonly canReview: (
    reviewerUserId: string,
    practitionerProfileId: string,
  ) => Effect.Effect<boolean, SqlError.SqlError>;
}

export class ReviewService extends Context.Tag("ReviewService")<
  ReviewService,
  ReviewServiceService
>() {}

export const ReviewServiceLive = Layer.effect(
  ReviewService,
  Effect.gen(function* () {
    const repo = yield* ReviewRepo;
    const practitionerRepo = yield* PractitionerRepo;
    const ids = yield* IdGenerator;
    const sql = yield* SqlClient.SqlClient;

    // A review targets only a real, verified practitioner (unknown/unverified → 404,
    // matching the public-profile posture so ids aren't probed).
    const requireVerified = (practitionerProfileId: string) =>
      practitionerRepo
        .findById(practitionerProfileId)
        .pipe(
          Effect.flatMap((found) =>
            found === undefined || found.verificationStatus !== "verified"
              ? Effect.fail(new NotFound({ resource: "Practitioner", id: practitionerProfileId }))
              : Effect.void,
          ),
        );

    return {
      upsertReview: (reviewerUserId, practitionerProfileId, input) =>
        Effect.gen(function* () {
          yield* requireVerified(practitionerProfileId);
          yield* assertCanReview(practitionerProfileId);
          const now = new Date(yield* Clock.currentTimeMillis);
          // upsert + recompute are one atomic unit so the aggregate never drifts.
          const created = yield* sql.withTransaction(
            Effect.gen(function* () {
              const existing = yield* repo.findActiveByPair(reviewerUserId, practitionerProfileId);
              if (existing === undefined) {
                const id = yield* ids.next;
                yield* repo.insert({
                  id,
                  practitionerProfileId,
                  reviewerUserId,
                  rating: input.rating,
                  comment: input.comment ?? null,
                  createdAt: now,
                  updatedAt: now,
                });
              } else {
                yield* repo.update(existing.id, {
                  rating: input.rating,
                  comment: input.comment ?? null,
                  updatedAt: now,
                });
              }
              yield* repo.recomputeRating(practitionerProfileId, now);
              return existing === undefined;
            }),
          );
          const review = yield* repo.findActiveByPair(reviewerUserId, practitionerProfileId);
          return {
            review: review ?? (yield* Effect.dieMessage("review missing after upsert")),
            created,
          };
        }),

      deleteOwnReview: (reviewerUserId, practitionerProfileId) =>
        Effect.gen(function* () {
          const now = new Date(yield* Clock.currentTimeMillis);
          yield* sql.withTransaction(
            Effect.gen(function* () {
              const existing = yield* repo.findActiveByPair(reviewerUserId, practitionerProfileId);
              if (existing === undefined) {
                return yield* Effect.fail(new NotFound({ resource: "Review" }));
              }
              yield* repo.softDelete(existing.id, now);
              yield* repo.recomputeRating(practitionerProfileId, now);
            }),
          );
        }),

      listReviews: (practitionerProfileId, limit, cursor, rating, sort) =>
        Effect.gen(function* () {
          yield* requireVerified(practitionerProfileId);
          let decodedCursor: ReviewCursor | undefined;
          if (cursor !== undefined) {
            decodedCursor = decodeReviewCursor(cursor);
            if (decodedCursor === undefined) {
              return yield* Effect.fail(
                new ValidationFailed({ issues: [{ path: "cursor", message: "Invalid cursor." }] }),
              );
            }
          }
          const rows = yield* repo.listByPractitioner(
            practitionerProfileId,
            limit + 1,
            decodedCursor,
            rating,
            sort,
          );
          const hasNextPage = rows.length > limit;
          const data = hasNextPage ? rows.slice(0, limit) : rows;
          const last = data.at(-1);
          return {
            data,
            meta: {
              count: data.length,
              limit,
              nextCursor: hasNextPage && last ? encodeReviewCursor(last) : null,
              hasNextPage,
            },
          };
        }),

      getOwnReview: (reviewerUserId, practitionerProfileId) =>
        requireVerified(practitionerProfileId).pipe(
          Effect.zipRight(repo.findActiveByPair(reviewerUserId, practitionerProfileId)),
          Effect.flatMap((found) =>
            found ? Effect.succeed(found) : Effect.fail(new NotFound({ resource: "Review" })),
          ),
        ),

      summary: (practitionerProfileId) =>
        requireVerified(practitionerProfileId).pipe(
          Effect.zipRight(repo.summary(practitionerProfileId)),
        ),

      canReview: () => Effect.succeed(false),
    } satisfies ReviewServiceService;
  }),
);
