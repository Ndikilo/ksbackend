import { z } from "@hono/zod-openapi";
import { CONSULTATION_TYPES } from "@/domain/practitioner/practitioner";
import { PRACTITIONER_SORT_FIELDS } from "@/domain/practitioner/search";
import { offsetPaginated, OffsetQuery } from "@/http/schemas";

/**
 * Query for `GET /v1/practitioners`. Every filter is optional so they combine and
 * clear freely. Single-field validation happens here (bad `sort`/out-of-range →
 * 422); cross-field rules (lat+lng together, feeMin ≤ feeMax, distance needs a
 * point) and the `consultationType` list are validated in the service, since a
 * query schema must stay a plain object for OpenAPI parameter generation.
 */
export const PractitionerSearchQuery = OffsetQuery.extend({
  sort: z
    .enum(PRACTITIONER_SORT_FIELDS)
    .default("recency")
    .openapi({ description: "Sort key (validated against the allow-list).", example: "rating" }),
  specialty: z.string().max(120).optional().openapi({
    description: "Clinical specialty (case-insensitive contains).",
    example: "Cardiology",
  }),
  city: z
    .string()
    .max(200)
    .optional()
    .openapi({ description: "Matches the practitioner's location (contains).", example: "Douala" }),
  language: z
    .string()
    .max(40)
    .optional()
    .openapi({ description: "A language the practitioner consults in.", example: "French" }),
  consultationType: z.string().max(60).optional().openapi({
    description:
      "Comma-separated list; matches practitioners offering ANY of these (in_person, video, home_visit).",
    example: "video,home_visit",
  }),
  feeMin: z.coerce
    .number()
    .int()
    .min(0)
    .max(10_000_000)
    .optional()
    .openapi({ description: "Minimum consultation fee (XAF).", example: 5000 }),
  feeMax: z.coerce
    .number()
    .int()
    .min(0)
    .max(10_000_000)
    .optional()
    .openapi({ description: "Maximum consultation fee (XAF).", example: 25000 }),
  professionId: z
    .uuid()
    .optional()
    .openapi({ description: "Restrict to one profession (e.g. a specific doctor/nurse kind)." }),
  q: z
    .string()
    .max(120)
    .optional()
    .openapi({ description: "Free text over name, specialty, and location.", example: "cardio" }),
  lat: z.coerce.number().min(-90).max(90).optional().openapi({
    description: "Searcher latitude — with `lng`, computes + enables sort by distance.",
  }),
  lng: z.coerce
    .number()
    .min(-180)
    .max(180)
    .optional()
    .openapi({ description: "Searcher longitude (must accompany `lat`)." }),
});

const PractitionerCard = z
  .object({
    id: z.uuid().openapi({
      description: "Practitioner profile id.",
      example: "3f1a2b6c-8d4e-4f9a-b1c2-0d3e4f5a6b7c",
    }),
    professionId: z.uuid().openapi({ description: "Profession id from the catalog." }),
    profession: z.object({
      id: z.uuid(),
      nameEn: z.string(),
      nameFr: z.string(),
      prefixHint: z.string().nullable(),
    }),
    languages: z.array(
      z.object({
        id: z.uuid(),
        code: z.string().length(2),
        nameEn: z.string(),
        nameFr: z.string(),
      }),
    ),
    prefix: z
      .string()
      .nullable()
      .openapi({ description: "Title before the name.", example: "Dr." }),
    surname: z.string().openapi({ description: "Family name.", example: "Nkemtaji" }),
    givenNames: z.string().openapi({ description: "Given name(s).", example: "Emmanuel" }),
    specialty: z
      .string()
      .nullable()
      .openapi({ description: "Clinical specialty.", example: "Cardiology" }),
    location: z.string().nullable().openapi({ description: "City / region.", example: "Douala" }),
    consultationTypes: z
      .array(z.enum(CONSULTATION_TYPES))
      .nullable()
      .openapi({ description: "How the practitioner consults.", example: ["in_person", "video"] }),
    consultationFeeXaf: z
      .number()
      .int()
      .nullable()
      .openapi({ description: "Consultation fee in XAF.", example: 15000 }),
    rating: z
      .object({
        average: z
          .number()
          .openapi({ description: "Average rating 0–5 (0 when no reviews).", example: 4.6 }),
        count: z.number().int().openapi({ description: "Number of reviews.", example: 128 }),
      })
      .openapi({ description: "Patient rating summary." }),
    nextAvailableAt: z
      .string()
      .nullable()
      .openapi({ description: "ISO timestamp of the soonest open future slot; null if none." }),
    distanceKm: z.number().nullable().openapi({
      description: "Distance from the searcher in km; present only when lat & lng were supplied.",
    }),
    photoUrl: z
      .string()
      .nullable()
      .openapi({ description: "Presigned download URL for the profile photo; null if none." }),
  })
  .openapi("PractitionerCard");

export const PractitionerSearchResponse = offsetPaginated(PractitionerCard).openapi(
  "PractitionerSearchResponse",
);
