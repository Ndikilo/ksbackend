import { z } from "@hono/zod-openapi";
import { CONSULTATION_TYPES } from "@/domain/practitioner/practitioner";

const LocationFields = z
  .object({
    label: z.string().trim().min(1).max(80),
    addressLine1: z.string().trim().min(1).max(180),
    addressLine2: z.string().trim().max(180).optional(),
    city: z.string().trim().min(1).max(80),
    region: z.string().trim().min(1).max(80),
    country: z.string().trim().length(2),
    consultationTypes: z.array(z.enum(CONSULTATION_TYPES)).min(1).max(3),
    isPrimary: z.boolean(),
  })
  .openapi("PracticeLocationFields");
export const CreateLocationBody = LocationFields.extend({
  id: z.uuidv7().optional(),
  country: z.string().trim().length(2).default("CM"),
  isPrimary: z.boolean().default(false),
}).openapi("CreatePracticeLocationBody");
export const UpdateLocationBody = LocationFields.partial()
  .extend({ addressLine2: z.string().trim().max(180).nullable().optional() })
  .openapi("UpdatePracticeLocationBody");
export const LocationResponse = LocationFields.extend({
  id: z.uuid(),
  addressLine2: z.string().nullable(),
  latitude: z.number().nullable(),
  longitude: z.number().nullable(),
}).openapi("PracticeLocation");
export const LocationsResponse = z
  .object({
    data: z.array(LocationResponse),
    meta: z.object({
      count: z.number().int().nonnegative(),
      limit: z.number().int().nonnegative(),
      nextCursor: z.null(),
      hasNextPage: z.literal(false),
    }),
  })
  .openapi("PracticeLocations");
