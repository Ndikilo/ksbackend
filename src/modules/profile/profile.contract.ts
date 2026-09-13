import { z } from "@hono/zod-openapi";

const phone = z
  .string()
  .regex(/^\+[1-9]\d{6,14}$/, "Phone must be E.164, e.g. +237650000000")
  .openapi({ description: "E.164 phone number.", example: "+237650000000" });

export const UpdateProfileBody = z
  .object({
    surname: z
      .string()
      .min(1)
      .max(120)
      .optional()
      .openapi({ description: "Family name.", example: "Mbeki" }),
    givenNames: z
      .string()
      .min(1)
      .max(120)
      .optional()
      .openapi({ description: "Given name(s).", example: "Ama" }),
    phone: phone.nullable().optional().openapi({
      description: "Contact number in E.164; send null to clear it.",
      example: "+237650000000",
    }),
    dateOfBirth: z.iso
      .date()
      .optional()
      .openapi({ description: "Date of birth (YYYY-MM-DD).", example: "1990-05-01" }),
    sex: z
      .enum(["male", "female"])
      .optional()
      .openapi({ description: "Biological sex on record.", example: "female" }),
    avatarFileKey: z.string().min(1).max(300).optional().openapi({
      description: "The `key` returned by POST /v1/me/avatar/presign, after you PUT the image.",
    }),
  })
  .openapi("UpdateProfile");

export const ProfileResponse = z
  .object({
    id: z.uuid().openapi({ description: "Profile id (distinct from the user id)." }),
    userId: z.string().openapi({ description: "The owning user's id." }),
    surname: z.string().openapi({ description: "Family name.", example: "Mbeki" }),
    givenNames: z.string().openapi({ description: "Given name(s).", example: "Ama" }),
    phone: z.string().nullable().openapi({
      description: "Contact number in E.164, or null if unset.",
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
    avatarFileKey: z
      .string()
      .nullable()
      .openapi({ description: "Storage key of the avatar; resolve to a URL via your media host." }),
  })
  .openapi("Profile");

export const AvatarPresignBody = z
  .object({
    contentType: z
      .enum(["image/jpeg", "image/png"])
      .openapi({ description: "MIME type of the image you're about to upload." }),
  })
  .openapi("AvatarPresign");

export const AvatarPresignResponse = z
  .object({
    url: z.string().openapi({
      description: "Short-lived URL — PUT the raw image bytes here (no auth header needed).",
    }),
    key: z.string().openapi({
      description:
        "Send this back as `avatarFileKey` on PATCH /v1/me/profile once the PUT succeeds.",
    }),
  })
  .openapi("AvatarPresignResult");
