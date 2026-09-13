/** Biological sex captured for care. Shared across every profile kind. */
export type Sex = "male" | "female";

/**
 * The base profile every user has, 1:1 with the better-auth `user`. Holds the
 * identity/contact/consent common to all roles; role-specific data lives in the
 * per-role extension tables (patient/practitioner/admin).
 */
export type Profile = {
  readonly id: string;
  readonly userId: string;
  readonly surname: string;
  readonly givenNames: string;
  readonly phone: string | null;
  readonly dateOfBirth: string | null;
  readonly sex: Sex | null;
  readonly avatarFileKey: string | null;
  readonly consentAcceptedAt: Date;
  readonly consentVersion: string;
};

/** Editable base-profile fields (PATCH /v1/me/profile). Consent is not editable. */
export type ProfilePatch = {
  readonly surname?: string | undefined;
  readonly givenNames?: string | undefined;
  readonly phone?: string | null | undefined;
  readonly dateOfBirth?: string | undefined;
  readonly sex?: Sex | undefined;
  readonly avatarFileKey?: string | undefined;
};
