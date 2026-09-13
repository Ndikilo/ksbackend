import { z } from "@hono/zod-openapi";
import { REVIEW_SORTS } from "@/domain/review/review";
import { paginated } from "@/http/schemas";

export const UpsertReviewBody = z
  .object({
    rating: z
      .number()
      .int()
      .min(1)
      .max(5)
      .openapi({ description: "Star rating from 1 to 5.", example: 5 }),
    comment: z
      .string()
      .max(2000)
      .optional()
      .openapi({ description: "Optional free-text comment.", example: "Attentive and thorough." }),
  })
  .openapi("UpsertReview");

export const ReviewResponse = z
  .object({
    id: z.uuid().openapi({ description: "Review id." }),
    practitionerProfileId: z.uuid().openapi({ description: "The reviewed practitioner's id." }),
    reviewerName: z.string().nullable().openapi({
      description: "The reviewer's given name; null if unavailable.",
      example: "Marie",
    }),
    verifiedAppointment: z.boolean().openapi({
      description: "Whether a completed appointment backs this review.",
      example: false,
    }),
    rating: z.number().int().openapi({ description: "Star rating 1–5.", example: 5 }),
    comment: z
      .string()
      .nullable()
      .openapi({ description: "Optional comment.", example: "Attentive and thorough." }),
    createdAt: z.string().openapi({ description: "ISO-8601 creation timestamp." }),
    updatedAt: z.string().openapi({ description: "ISO-8601 last-updated timestamp." }),
  })
  .openapi("Review");

export const ReviewsPage = paginated(ReviewResponse).openapi("Reviews");

export const ReviewSummaryResponse = z
  .object({
    average: z.number(),
    count: z.number().int().nonnegative(),
    distribution: z.object({
      1: z.number().int().nonnegative(),
      2: z.number().int().nonnegative(),
      3: z.number().int().nonnegative(),
      4: z.number().int().nonnegative(),
      5: z.number().int().nonnegative(),
    }),
  })
  .openapi("ReviewSummary");

export const ReviewListQuery = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(20),
  cursor: z.string().max(500).optional(),
  rating: z.coerce.number().int().min(1).max(5).optional(),
  sort: z.enum(REVIEW_SORTS).default("newest"),
});
