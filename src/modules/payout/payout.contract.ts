import { z } from "@hono/zod-openapi";
import { PAYOUT_METHOD_KINDS } from "@/domain/payout/payout";
const PayoutFields = z
  .object({
    kind: z.enum(PAYOUT_METHOD_KINDS),
    accountName: z.string().trim().min(2).max(120),
    accountNumber: z.string().trim().min(6).max(34),
    bankName: z.string().trim().min(2).max(120).optional(),
    isDefault: z.boolean(),
  })
  .openapi("PayoutMethodFields");
export const CreatePayoutBody = PayoutFields.extend({
  id: z.uuidv7().optional(),
  isDefault: z.boolean().default(false),
}).openapi("CreatePayoutMethodBody");
export const UpdatePayoutBody = PayoutFields.partial()
  .extend({ bankName: z.string().trim().min(2).max(120).nullable().optional() })
  .openapi("UpdatePayoutMethodBody");
export const PayoutResponse = z
  .object({
    id: z.uuid(),
    kind: z.enum(PAYOUT_METHOD_KINDS),
    accountName: z.string(),
    maskedAccountNumber: z.string(),
    bankName: z.string().nullable(),
    isDefault: z.boolean(),
  })
  .openapi("PayoutMethod");
export const PayoutsResponse = z
  .object({
    data: z.array(PayoutResponse),
    meta: z.object({
      count: z.number().int().nonnegative(),
      limit: z.number().int().nonnegative(),
      nextCursor: z.null(),
      hasNextPage: z.literal(false),
    }),
  })
  .openapi("PayoutMethods");
