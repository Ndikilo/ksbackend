import { z } from "@hono/zod-openapi";
import { CONSULTATION_TYPES } from "@/domain/practitioner/practitioner";

const phone = z
  .string()
  .regex(/^\+[1-9]\d{6,14}$/, "Phone must be E.164, e.g. +237650000000")
  .optional()
  .openapi({ description: "E.164 phone number.", example: "+237650000000" });

export const RegisterPractitionerBody = z
  .object({
    role: z
      .enum(["doctor", "nurse"])
      .openapi({ description: "Which kind of practitioner to register as.", example: "doctor" }),
    professionId: z.uuid().openapi({
      description: "UUID of the chosen profession from the professions catalog.",
      example: "3f1a2b6c-8d4e-4f9a-b1c2-0d3e4f5a6b7c",
    }),
    prefix: z
      .string()
      .max(20)
      .optional()
      .openapi({ description: "Title shown before the name.", example: "Dr." }),
    surname: z
      .string()
      .min(1)
      .max(120)
      .openapi({ description: "Family name.", example: "Nkemtaji" }),
    givenNames: z
      .string()
      .min(1)
      .max(120)
      .openapi({ description: "Given name(s).", example: "Emmanuel" }),
    phone,
    dateOfBirth: z.iso
      .date()
      .optional()
      .openapi({ description: "Date of birth (YYYY-MM-DD).", example: "1985-03-12" }),
    sex: z
      .enum(["male", "female"])
      .optional()
      .openapi({ description: "Biological sex.", example: "male" }),
    location: z.string().max(200).optional().openapi({
      description: "City / region where the practitioner is based.",
      example: "Douala",
    }),
    consultationTypes: z.array(z.enum(CONSULTATION_TYPES)).max(3).optional(),
    consentVersion: z
      .string()
      .min(1)
      .max(20)
      .openapi({ description: "Version of the terms the user consented to.", example: "2025-01" }),
    acceptTerms: z
      .literal(true)
      .openapi({ description: "Must be `true` — the user must accept the terms to register." }),
  })
  .openapi("RegisterPractitioner");

export const PresignDocumentBody = z
  .object({
    kind: z.enum(["cmc-certificate", "nic", "profile-photo"]).openapi({
      description:
        "Which document this upload is for. `cmc-certificate` = Cameroon Medical Council registration certificate; `nic` = national ID card; `profile-photo` = the practitioner's photo.",
      example: "cmc-certificate",
    }),
    contentType: z.string().min(1).max(100).openapi({
      description: "MIME type of the file you're about to upload.",
      example: "application/pdf",
    }),
  })
  .openapi("PresignDocument");

export const PresignDocumentResponse = z
  .object({
    url: z.string().openapi({
      description: "Short-lived URL — PUT the raw file bytes here (no auth header needed).",
    }),
    key: z.string().openapi({
      description:
        "Storage key of the uploaded file. Send it back on POST /v1/practitioners/me/credentials once the PUT succeeds.",
      example: "practitioners/3f1a2b6c/cmc-certificate/1a2b3c.pdf",
    }),
  })
  .openapi("PresignedUpload");

export const SubmitCredentialsBody = z
  .object({
    cmcRegistrationNumber: z.string().min(3).max(60).openapi({
      description: "Cameroon Medical Council registration number.",
      example: "CMC-2024-01234",
    }),
    nicNumber: z
      .string()
      .min(3)
      .max(60)
      .openapi({ description: "National ID card (NIC) number.", example: "123456789" }),
    cmcCertificateFileKey: z.string().min(1).openapi({
      description: "The `key` returned by the presign call for `kind: cmc-certificate`.",
      example: "practitioners/3f1a2b6c/cmc-certificate/1a2b3c.pdf",
    }),
    nicFileKey: z.string().min(1).openapi({
      description: "The `key` returned by the presign call for `kind: nic`.",
      example: "practitioners/3f1a2b6c/nic/4d5e6f.jpg",
    }),
    profilePhotoFileKey: z.string().min(1).openapi({
      description: "The `key` returned by the presign call for `kind: profile-photo`.",
      example: "practitioners/3f1a2b6c/profile-photo/7g8h9i.jpg",
    }),
  })
  .openapi("SubmitCredentials");

const publicFields = {
  specialty: z
    .string()
    .nullable()
    .openapi({ description: "Clinical specialty. Null until set.", example: "Cardiology" }),
  bio: z.string().nullable().openapi({
    description: "Free-text professional bio shown to patients. Null until set.",
    example: "Board-certified cardiologist with a focus on preventive care.",
  }),
  languagesSpoken: z
    .array(z.string())
    .nullable()
    .openapi({
      description: "Languages the practitioner consults in. Null until set.",
      example: ["French", "English"],
    }),
  yearsExperience: z
    .number()
    .int()
    .nullable()
    .openapi({ description: "Years of professional experience. Null until set.", example: 8 }),
  consultationFeeXaf: z.number().int().nullable().openapi({
    description: "Consultation fee in XAF (integer, no decimals). Null until set.",
    example: 15000,
  }),
  consultationTypes: z
    .array(z.enum(CONSULTATION_TYPES))
    .nullable()
    .openapi({
      description: "How the practitioner consults. Null until set.",
      example: ["in_person", "video"],
    }),
  ratingAverage: z.number().openapi({
    description: "Average patient rating (0–5, one decimal). 0 when there are no reviews yet.",
    example: 4.6,
  }),
  ratingCount: z.number().int().openapi({
    description: "Number of patient reviews backing the average.",
    example: 128,
  }),
};

export const PractitionerResponse = z
  .object({
    id: z.uuid().openapi({
      description: "Practitioner profile id (distinct from the user id).",
      example: "3f1a2b6c-8d4e-4f9a-b1c2-0d3e4f5a6b7c",
    }),
    userId: z.string().openapi({ description: "The owning user's id.", example: "usr_9f3c…" }),
    professionId: z.uuid().openapi({
      description: "UUID of the profession from the professions catalog.",
      example: "3f1a2b6c-8d4e-4f9a-b1c2-0d3e4f5a6b7c",
    }),
    prefix: z
      .string()
      .nullable()
      .openapi({ description: "Title shown before the name.", example: "Dr." }),
    surname: z.string().openapi({ description: "Family name.", example: "Nkemtaji" }),
    givenNames: z.string().openapi({ description: "Given name(s).", example: "Emmanuel" }),
    phone: z
      .string()
      .nullable()
      .openapi({ description: "E.164 phone number (private).", example: "+237650000000" }),
    dateOfBirth: z
      .string()
      .nullable()
      .openapi({ description: "Date of birth, YYYY-MM-DD (private).", example: "1985-03-12" }),
    sex: z
      .enum(["male", "female"])
      .nullable()
      .openapi({ description: "Biological sex (private).", example: "male" }),
    location: z.string().nullable().openapi({ description: "City / region.", example: "Douala" }),
    ...publicFields,
    verificationStatus: z
      .enum(["incomplete", "pending_verification", "verified", "rejected"])
      .openapi({
        description:
          "Where the profile sits in the verification flow. `incomplete` = registered, credentials not yet submitted; `pending_verification` = credentials submitted, awaiting admin review; `verified` = approved and publicly bookable; `rejected` = admin rejected the credentials.",
        example: "incomplete",
      }),
  })
  .openapi("Practitioner");

export const UpdatePublicProfileBody = z
  .object({
    prefix: z
      .string()
      .max(20)
      .optional()
      .openapi({ description: "Title shown before the name.", example: "Dr." }),
    location: z.string().max(200).optional().openapi({
      description: "City / region where the practitioner is based.",
      example: "Douala",
    }),
    specialty: z
      .string()
      .max(120)
      .optional()
      .openapi({ description: "Clinical specialty.", example: "Cardiology" }),
    bio: z.string().max(2000).optional().openapi({
      description: "Free-text professional bio shown to patients.",
      example: "Board-certified cardiologist with a focus on preventive care.",
    }),
    languagesSpoken: z
      .array(z.string().min(1).max(40))
      .max(10)
      .optional()
      .openapi({
        description: "Languages the practitioner consults in (max 10).",
        example: ["French", "English"],
      }),
    yearsExperience: z
      .number()
      .int()
      .min(0)
      .max(80)
      .optional()
      .openapi({ description: "Years of professional experience (0–80).", example: 8 }),
    consultationFeeXaf: z
      .number()
      .int()
      .min(0)
      .max(10_000_000)
      .optional()
      .openapi({ description: "Consultation fee in XAF (integer, no decimals).", example: 15000 }),
    consultationTypes: z
      .array(z.enum(CONSULTATION_TYPES))
      .max(3)
      .optional()
      .openapi({
        description: "How the practitioner consults (any of in_person, video, home_visit).",
        example: ["in_person", "video"],
      }),
    profilePhotoFileKey: z.string().min(1).max(500).optional().openapi({
      description: "Owned profile-photo storage key returned by the presign endpoint.",
    }),
  })
  .openapi("UpdatePublicProfile");

// Public/bookable view — no phone/DOB/sex/identifiers.
export const PublicPractitionerResponse = z
  .object({
    id: z.uuid().openapi({
      description: "Practitioner profile id.",
      example: "3f1a2b6c-8d4e-4f9a-b1c2-0d3e4f5a6b7c",
    }),
    professionId: z.uuid().openapi({
      description: "UUID of the profession from the professions catalog.",
      example: "3f1a2b6c-8d4e-4f9a-b1c2-0d3e4f5a6b7c",
    }),
    profession: z.object({
      id: z.uuid(),
      nameEn: z.string(),
      nameFr: z.string(),
      prefixHint: z.string().nullable(),
    }),
    prefix: z
      .string()
      .nullable()
      .openapi({ description: "Title shown before the name.", example: "Dr." }),
    surname: z.string().openapi({ description: "Family name.", example: "Nkemtaji" }),
    givenNames: z.string().openapi({ description: "Given name(s).", example: "Emmanuel" }),
    location: z.string().nullable().openapi({ description: "City / region.", example: "Douala" }),
    ...publicFields,
    memberSince: z.string(),
    languages: z.array(
      z.object({
        id: z.uuid(),
        code: z.string().length(2),
        nameEn: z.string(),
        nameFr: z.string(),
      }),
    ),
    qualifications: z.array(
      z.object({
        id: z.uuid(),
        kind: z.enum(["degree", "specialisation", "certification", "training", "award"]),
        title: z.string(),
        institution: z.string(),
        country: z.string(),
        year: z.number().int(),
        sortOrder: z.number().int(),
        verifiedAt: z.string().nullable(),
      }),
    ),
    locations: z.array(
      z.object({
        id: z.uuid(),
        label: z.string(),
        addressLine1: z.string(),
        addressLine2: z.string().nullable(),
        city: z.string(),
        region: z.string(),
        country: z.string(),
        latitude: z.number().nullable(),
        longitude: z.number().nullable(),
        consultationTypes: z.array(z.enum(CONSULTATION_TYPES)),
        isPrimary: z.boolean(),
      }),
    ),
    offerings: z.array(
      z.object({
        id: z.uuid(),
        consultationType: z.enum(CONSULTATION_TYPES),
        durationMin: z.number().int(),
        priceXaf: z.number().int(),
        active: z.boolean(),
      }),
    ),
    rating: z.object({
      average: z.number(),
      count: z.number().int(),
      distribution: z.object({
        1: z.number().int(),
        2: z.number().int(),
        3: z.number().int(),
        4: z.number().int(),
        5: z.number().int(),
      }),
    }),
    verification: z.object({
      status: z.literal("verified"),
      body: z.literal("CMC"),
      registrationNumber: z.string(),
    }),
    booking: z.object({ bookable: z.boolean(), reasons: z.array(z.string()) }),
    canReview: z.literal(false),
    photoUrl: z.string().nullable().openapi({
      description: "Presigned download URL for the profile photo. Null if none is set.",
      example:
        "https://media.kanasante.example/practitioners/3f1a2b6c/profile-photo/7g8h9i.jpg?sig=…",
    }),
    nextAvailableAt: z.string().nullable().openapi({
      description: "ISO-8601 timestamp of the soonest open future slot; null if none.",
      example: "2026-09-01T09:00:00.000Z",
    }),
  })
  .openapi("PublicPractitioner");

export const PractitionerVerificationResponse = z
  .object({
    status: z.enum(["incomplete", "pending_verification", "verified", "rejected"]),
    submittedAt: z.string().nullable(),
    documents: z.array(
      z.object({
        kind: z.enum(["cmc-certificate", "nic", "profile-photo"]),
        url: z.string(),
        uploadedAt: z.string(),
      }),
    ),
    latestDecision: z
      .object({
        decision: z.enum(["approved", "rejected"]),
        reason: z.string().nullable(),
        createdAt: z.string(),
      })
      .nullable(),
    canResubmit: z.boolean(),
  })
  .openapi("PractitionerVerification");
