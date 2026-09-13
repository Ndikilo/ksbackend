import { z } from "@hono/zod-openapi";
import { QUALIFICATION_KINDS } from "@/domain/qualification/qualification";

const QualificationFields = z
  .object({
    kind: z.enum(QUALIFICATION_KINDS),
    title: z.string().trim().min(1).max(160),
    institution: z.string().trim().min(1).max(160),
    country: z.string().trim().min(2).max(80),
    year: z.number().int().min(1900).max(2100),
    sortOrder: z.number().int().min(0).max(1000).default(0),
  })
  .openapi("QualificationFields");

export const CreateQualificationBody = QualificationFields.extend({
  id: z.uuidv7().optional(),
}).openapi("CreateQualificationBody");

export const UpdateQualificationBody =
  QualificationFields.partial().openapi("UpdateQualificationBody");

export const QualificationResponse = QualificationFields.extend({
  id: z.uuid(),
  verifiedAt: z.string().nullable(),
}).openapi("Qualification");

export const QualificationsResponse = z
  .object({
    data: z.array(QualificationResponse),
    meta: z.object({
      count: z.number().int().nonnegative(),
      limit: z.number().int().nonnegative(),
      nextCursor: z.null(),
      hasNextPage: z.literal(false),
    }),
  })
  .openapi("Qualifications");
