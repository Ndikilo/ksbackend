import { z } from "@hono/zod-openapi";
import { PATIENT_SORT_FIELDS } from "@/domain/patient/search";
import { offsetPaginated, OffsetQuery } from "@/http/schemas";

/** Query for `GET /v1/patients` (admin only). Filters are optional/independent. */
export const PatientSearchQuery = OffsetQuery.extend({
  sort: z
    .enum(PATIENT_SORT_FIELDS)
    .default("recency")
    .openapi({ description: "Sort key (name | recency).", example: "name" }),
  q: z
    .string()
    .max(120)
    .optional()
    .openapi({ description: "Typo-tolerant free text over the patient's name.", example: "abena" }),
});

const PatientCard = z
  .object({
    id: z.uuid().openapi({ description: "Patient profile id." }),
    surname: z.string().openapi({ description: "Family name.", example: "Abena" }),
    givenNames: z.string().openapi({ description: "Given name(s).", example: "Marie" }),
  })
  .openapi("PatientCard");

export const PatientSearchResponse = offsetPaginated(PatientCard).openapi("PatientSearchResponse");
