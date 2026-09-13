import { z } from "@hono/zod-openapi";
import { AVAILABILITY_EXCEPTION_KINDS, SLOT_STATUSES } from "@/domain/availability/availability";
import { CONSULTATION_TYPES } from "@/domain/practitioner/practitioner";
import { paginated } from "@/http/schemas";

export const CreateSlotBody = z
  .object({
    id: z.uuidv7().optional(),
    startsAt: z.iso.datetime().openapi({
      description: "Slot start (ISO-8601, must be in the future).",
      example: "2026-09-01T09:00:00.000Z",
    }),
    endsAt: z.iso.datetime().openapi({
      description: "Slot end (ISO-8601, must be after startsAt).",
      example: "2026-09-01T09:30:00.000Z",
    }),
    consultationTypes: z.array(z.enum(CONSULTATION_TYPES)).max(3).default([]),
    locationId: z.uuid().nullable().default(null),
  })
  .openapi("CreateSlot");

export const SlotResponse = z
  .object({
    id: z.uuid().openapi({ description: "Slot id." }),
    startsAt: z.string().openapi({ description: "ISO-8601 start." }),
    endsAt: z.string().openapi({ description: "ISO-8601 end." }),
    consultationTypes: z.array(z.enum(CONSULTATION_TYPES)),
    locationId: z.uuid().nullable(),
    status: z.enum(SLOT_STATUSES).openapi({
      description: "Slot status. Only `open` is used until booking ships.",
      example: "open",
    }),
  })
  .openapi("Slot");

export const SlotsPage = paginated(SlotResponse).openapi("Slots");

const Time = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/);

export const AvailabilityRuleBody = z.object({
  weekday: z.number().int().min(0).max(6),
  startTime: Time,
  endTime: Time,
  slotDurationMin: z.number().int().min(5).max(240),
  consultationTypes: z.array(z.enum(CONSULTATION_TYPES)).min(1).max(3),
  locationId: z.uuid().nullable().default(null),
  timezone: z.literal("Africa/Douala").default("Africa/Douala"),
  validFrom: z.iso.date().nullable().default(null),
  validTo: z.iso.date().nullable().default(null),
});

export const ReplaceAvailabilityRulesBody = z
  .object({
    rules: z.array(AvailabilityRuleBody).max(28),
  })
  .openapi("ReplaceAvailabilityRules");

export const AvailabilityRuleResponse = AvailabilityRuleBody.extend({ id: z.uuid() }).openapi(
  "AvailabilityRule",
);
export const AvailabilityRulesResponse = z
  .object({
    data: z.array(AvailabilityRuleResponse),
    meta: z.object({
      count: z.number().int().nonnegative(),
      limit: z.number().int().nonnegative(),
      nextCursor: z.null(),
      hasNextPage: z.literal(false),
    }),
  })
  .openapi("AvailabilityRules");

export const AvailabilityExceptionBody = z
  .object({
    id: z.uuidv7().optional(),
    date: z.iso.date(),
    kind: z.enum(AVAILABILITY_EXCEPTION_KINDS),
    startTime: Time.nullable().default(null),
    endTime: Time.nullable().default(null),
    consultationTypes: z.array(z.enum(CONSULTATION_TYPES)).min(1).max(3).nullable().default(null),
    locationId: z.uuid().nullable().default(null),
  })
  .openapi("AvailabilityExceptionBody");

export const AvailabilityExceptionResponse = AvailabilityExceptionBody.extend({
  id: z.uuid(),
}).openapi("AvailabilityException");

export const PublicSlotResponse = z
  .object({
    key: z.string(),
    startsAt: z.string(),
    endsAt: z.string(),
    consultationTypes: z.array(z.enum(CONSULTATION_TYPES)),
    locationId: z.uuid().nullable(),
    source: z.enum(["rule", "exception", "explicit"]),
  })
  .openapi("PublicAvailabilitySlot");

export const PublicSlotsResponse = z
  .object({
    data: z.array(PublicSlotResponse),
    meta: z.object({ count: z.number().int().nonnegative(), from: z.string(), to: z.string() }),
  })
  .openapi("PublicAvailabilitySlots");
export const AvailabilityDaysResponse = z
  .object({
    data: z.array(z.iso.date()),
    meta: z.object({ count: z.number().int().nonnegative(), month: z.string() }),
  })
  .openapi("AvailabilityDays");
