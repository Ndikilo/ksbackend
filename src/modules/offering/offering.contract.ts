import { z } from "@hono/zod-openapi";
import { CONSULTATION_TYPES } from "@/domain/practitioner/practitioner";
const OfferingFields = z
  .object({
    consultationType: z.enum(CONSULTATION_TYPES),
    durationMin: z.number().int().min(5).max(240),
    priceXaf: z.number().int().min(0).max(10_000_000),
    active: z.boolean(),
  })
  .openapi("ConsultationOfferingFields");
export const CreateOfferingBody = OfferingFields.extend({
  id: z.uuidv7().optional(),
  active: z.boolean().default(true),
}).openapi("CreateConsultationOfferingBody");
export const UpdateOfferingBody = OfferingFields.partial().openapi(
  "UpdateConsultationOfferingBody",
);
export const OfferingResponse = OfferingFields.extend({ id: z.uuid() }).openapi(
  "ConsultationOffering",
);
export const OfferingsResponse = z
  .object({
    data: z.array(OfferingResponse),
    meta: z.object({
      count: z.number().int().nonnegative(),
      limit: z.number().int().nonnegative(),
      nextCursor: z.null(),
      hasNextPage: z.literal(false),
    }),
  })
  .openapi("ConsultationOfferings");
export const EarningsTermsResponse = z
  .object({ commissionBps: z.number().int(), commissionPercent: z.number() })
  .openapi("EarningsTerms");
