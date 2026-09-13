import { z } from "@hono/zod-openapi";
import { paginated } from "@/http/schemas";

const relationship = z.enum(["child", "parent", "spouse", "sibling", "other"]).openapi({
  description: "How the caregiver (inviter) relates to the invitee.",
  example: "parent",
});

export const InviteBody = z
  .object({
    inviteeEmail: z.email().openapi({
      description:
        "Email of the existing account-holder to link as a dependent. A token is emailed to this address; it is never returned in the response.",
      example: "ama@example.com",
    }),
    relationship,
  })
  .openapi("InviteDependent");

const linkView = z.object({
  id: z.uuid().openapi({
    description:
      "The caregiver link's id — pass this to DELETE /v1/dependents/links/{id} to revoke.",
    example: "7c9e6679-7425-40de-944b-e07fc1f90ae7",
  }),
  caregiverUserId: z.string().openapi({
    description: "User id of the caregiver (the party who sent the invite).",
    example: "usr_9f3c…",
  }),
  subjectUserId: z.string().nullable().openapi({
    description:
      "User id of the dependent (invitee) once the link is active; null while still pending.",
    example: "usr_a1b2…",
  }),
  inviteIdentifier: z.string().nullable().openapi({
    description: "Email the invite was addressed to while pending; null once accepted.",
    example: "ama@example.com",
  }),
  relationship,
  status: z.enum(["pending", "active", "revoked", "declined"]).openapi({
    description:
      "Lifecycle of the link: `pending` (awaiting response), `active` (accepted), `declined`, or `revoked` (cancelled by either party).",
    example: "pending",
  }),
  direction: z.enum(["sent", "received"]).openapi({
    description:
      "Relative to the current user: `sent` if they are the caregiver who invited, `received` if they are the invitee.",
    example: "sent",
  }),
});

export const LinkResponse = linkView.openapi("CaregiverLink");

export const LinksPage = paginated(linkView).openapi("CaregiverLinksPage");

export const TokenParam = z.object({
  token: z.string().min(1).openapi({
    description:
      "The opaque invitation token delivered by email to the invitee. Never exposed via any list endpoint.",
    example: "iv_2yQ8s7Kd3nLpR4mV6wX0",
  }),
});
export const LinkIdParam = z.object({
  id: z.uuid().openapi({
    description: "The caregiver link's id (from a link/invitation response).",
    example: "7c9e6679-7425-40de-944b-e07fc1f90ae7",
  }),
});

export const UserSearchQuery = z.object({
  email: z.email().openapi({
    description: "Exact email to check for an existing account.",
    example: "ama@example.com",
  }),
});
// Existence only — no name/userId — to avoid enumeration + PII disclosure.
// Names become mutually visible after an invite is accepted.
export const UserSearchResponse = z
  .object({
    exists: z.boolean().openapi({
      description:
        "Whether an account exists for the exact email. Deliberately the only field — no name or id — to avoid user enumeration and PII disclosure.",
      example: true,
    }),
  })
  .openapi("UserSearchResult");
