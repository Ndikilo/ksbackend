import { z } from "@hono/zod-openapi";
import { paginated } from "@/http/schemas";
import { PractitionerResponse } from "@/modules/practitioner/practitioner.contract";

export const PendingVerificationsResponse =
  paginated(PractitionerResponse).openapi("PendingVerifications");

export const VerificationPractitionerResponse = PractitionerResponse.openapi({
  description:
    "The practitioner profile record under review (same shape as GET /v1/practitioners/me).",
});

export const VerificationDetailResponse = z
  .object({
    practitioner: VerificationPractitionerResponse,
    cmcRegistrationNumber: z.string().openapi({
      description:
        "DECRYPTED Cameroon Medical Council registration number — decrypted server-side for the reviewer; stored encrypted at rest.",
      example: "CMC-2021-004832",
    }),
    nicNumber: z.string().openapi({
      description:
        "DECRYPTED national identity card number — decrypted server-side for the reviewer; stored encrypted at rest.",
      example: "119045872",
    }),
    documents: z
      .object({
        cmcCertificateUrl: z.string().nullable().openapi({
          description:
            "Presigned, short-lived URL to the uploaded CMC certificate; null if none was submitted.",
          example: "https://files.kanasante.example/verifications/cmc-cert.pdf?sig=…",
        }),
        nicUrl: z.string().nullable().openapi({
          description:
            "Presigned, short-lived URL to the uploaded national identity card; null if none was submitted.",
          example: "https://files.kanasante.example/verifications/nic.jpg?sig=…",
        }),
        profilePhotoUrl: z.string().nullable().openapi({
          description:
            "Presigned, short-lived URL to the practitioner's profile photo; null if none was submitted.",
          example: "https://files.kanasante.example/verifications/photo.jpg?sig=…",
        }),
      })
      .openapi({
        description: "Presigned document URLs for review; each is nullable and expires.",
      }),
  })
  .openapi("VerificationDetail");

export const RejectBody = z
  .object({
    reason: z.string().min(3).max(500).openapi({
      description:
        "Why the submission was rejected (3–500 chars). Emailed to the practitioner so they can fix and resubmit.",
      example: "The uploaded CMC certificate is illegible; please re-upload a clear scan.",
    }),
  })
  .openapi("RejectVerification");
