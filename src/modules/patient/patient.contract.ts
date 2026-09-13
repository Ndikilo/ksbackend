import { z } from "@hono/zod-openapi";

const phone = z
  .string()
  .regex(/^\+[1-9]\d{6,14}$/, "Phone must be E.164, e.g. +237650000000")
  .optional()
  .openapi({
    description: "Patient's contact number in E.164 format. Optional.",
    example: "+237650000000",
  });

const emergencyContact = z
  .object({
    name: z
      .string()
      .min(1)
      .max(120)
      .openapi({ description: "Full name of the emergency contact.", example: "Ngo Mbeki" }),
    phone: z
      .string()
      .regex(/^\+[1-9]\d{6,14}$/, "Phone must be E.164")
      .openapi({
        description: "Emergency contact's phone in E.164 format.",
        example: "+237699000000",
      }),
    relationship: z
      .string()
      .min(1)
      .max(60)
      .openapi({ description: "How this contact relates to the patient.", example: "Sister" }),
  })
  .optional()
  .openapi({
    description:
      "Who to reach in an emergency. Optional — omit it and any existing contact is left untouched.",
  });

export const CompletePatientProfileBody = z
  .object({
    surname: z.string().min(1).max(120).openapi({ description: "Family name.", example: "Mbeki" }),
    givenNames: z
      .string()
      .min(1)
      .max(120)
      .openapi({ description: "Given name(s).", example: "Ama" }),
    phone,
    dateOfBirth: z.iso
      .date()
      .openapi({ description: "Date of birth (YYYY-MM-DD).", example: "1990-05-01" }),
    sex: z
      .enum(["male", "female"])
      .openapi({ description: "Biological sex on record.", example: "female" }),
    consentVersion: z.string().min(1).max(20).openapi({
      description: "Version of the terms/consent document the user is accepting.",
      example: "2025-01",
    }),
    acceptTerms: z.literal(true).openapi({
      description:
        "Must be the literal boolean `true` — the request is rejected otherwise. Records that the user accepted `consentVersion`.",
      example: true,
    }),
    emergencyContact,
  })
  .openapi("CompletePatientProfile");

export const PatientProfileResponse = z
  .object({
    id: z.uuid().openapi({ description: "Patient profile id (distinct from the user id)." }),
    userId: z.string().openapi({ description: "The owning user's id." }),
    surname: z.string().openapi({ description: "Family name.", example: "Mbeki" }),
    givenNames: z.string().openapi({ description: "Given name(s).", example: "Ama" }),
    phone: z.string().nullable().openapi({
      description: "Contact number in E.164, or null if not set.",
      example: "+237650000000",
    }),
    dateOfBirth: z
      .string()
      .nullable()
      .openapi({ description: "Date of birth (YYYY-MM-DD), or null.", example: "1990-05-01" }),
    sex: z
      .enum(["male", "female"])
      .nullable()
      .openapi({ description: "Biological sex on record, or null.", example: "female" }),
    emergencyContact: z
      .object({
        name: z
          .string()
          .openapi({ description: "Full name of the emergency contact.", example: "Ngo Mbeki" }),
        phone: z.string().openapi({
          description: "Emergency contact's phone in E.164.",
          example: "+237699000000",
        }),
        relationship: z
          .string()
          .openapi({ description: "How this contact relates to the patient.", example: "Sister" }),
      })
      .nullable()
      .openapi({ description: "The stored emergency contact, or null if none has been set." }),
  })
  .openapi("PatientProfile");
