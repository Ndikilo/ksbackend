import { z } from "@hono/zod-openapi";
import { paginated } from "@/http/schemas";

const phone = z
  .string()
  .regex(/^\+[1-9]\d{6,14}$/, "Phone must be E.164, e.g. +237650000000")
  .optional()
  .openapi({
    description: "E.164 phone number for the dependent (optional).",
    example: "+237650000000",
  });

const sex = z
  .enum(["male", "female"])
  .openapi({ description: "The dependent's sex.", example: "female" });

const relationship = z.enum(["child", "parent", "spouse", "sibling", "other"]).openapi({
  description:
    "How THIS caregiver relates to the dependent. Stored per-caregiver, so the same dependent may be a `child` to one caregiver and a `sibling` to another.",
  example: "child",
});

export const CreateDependentBody = z
  .object({
    surname: z.string().min(1).max(120).openapi({ description: "Family name.", example: "Nkeng" }),
    givenNames: z
      .string()
      .min(1)
      .max(120)
      .openapi({ description: "Given name(s).", example: "Ariane" }),
    dateOfBirth: z.iso
      .date()
      .openapi({ description: "Date of birth (YYYY-MM-DD).", example: "2015-03-02" }),
    sex,
    relationship,
    phone,
    location: z
      .string()
      .max(200)
      .optional()
      .openapi({ description: "Free-text town/region (optional).", example: "Bamenda, Cameroon" }),
  })
  .openapi("CreateDependent");

export const UpdateDependentBody = z
  .object({
    surname: z
      .string()
      .min(1)
      .max(120)
      .optional()
      .openapi({ description: "Family name — updates the dependent person.", example: "Nkeng" }),
    givenNames: z
      .string()
      .min(1)
      .max(120)
      .optional()
      .openapi({ description: "Given name(s) — updates the dependent person.", example: "Ariane" }),
    dateOfBirth: z.iso.date().optional().openapi({
      description: "Date of birth (YYYY-MM-DD) — updates the dependent person.",
      example: "2015-03-02",
    }),
    sex: sex.optional(),
    relationship: relationship.optional().openapi({
      description:
        "Updates only THIS caregiver's link — other caregivers' relationships are untouched.",
      example: "child",
    }),
    phone,
    location: z.string().max(200).optional().openapi({
      description: "Free-text town/region — updates the dependent person.",
      example: "Bamenda, Cameroon",
    }),
  })
  .openapi("UpdateDependent");

export const DependentResponse = z
  .object({
    id: z.uuid().openapi({
      description: "The dependent person's id.",
      example: "3fa85f64-5717-4562-b3fc-2c963f66afa6",
    }),
    surname: z.string().openapi({ description: "Family name.", example: "Nkeng" }),
    givenNames: z.string().openapi({ description: "Given name(s).", example: "Ariane" }),
    dateOfBirth: z
      .string()
      .openapi({ description: "Date of birth (YYYY-MM-DD).", example: "2015-03-02" }),
    sex,
    relationship,
    phone: z
      .string()
      .nullable()
      .openapi({ description: "E.164 phone number, or null.", example: "+237650000000" }),
    location: z
      .string()
      .nullable()
      .openapi({ description: "Free-text town/region, or null.", example: "Bamenda, Cameroon" }),
  })
  .openapi("Dependent");

export const DependentsPage = paginated(DependentResponse).openapi("DependentsPage");
