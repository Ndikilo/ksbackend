/** Least-privilege admin scopes. `super_admin` can do everything; a
 *  `verification_reviewer` may only act on practitioner verification. */
export type AdminScope = "super_admin" | "verification_reviewer";

export type AdminProfile = {
  readonly userId: string;
  readonly scope: AdminScope;
};
