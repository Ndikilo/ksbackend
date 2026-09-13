/**
 * Sort allow-list for admin patient search. A `const` tuple so the contract can
 * feed it to `z.enum(...)` (cast-free, auto-422 on unknown keys).
 */
export const PATIENT_SORT_FIELDS = ["name", "recency"] as const;
export type PatientSortField = (typeof PATIENT_SORT_FIELDS)[number];

export type SortDirection = "asc" | "desc";
export type PatientSort = { readonly field: PatientSortField; readonly direction: SortDirection };

export const PATIENT_SORT_DEFAULT_DIRECTION = {
  name: "asc",
  recency: "desc",
} satisfies Record<PatientSortField, SortDirection>;

/** Every filter optional so they combine and clear freely. */
export type PatientSearchCriteria = {
  readonly q?: string | undefined;
};

/** Non-sensitive identity only — never emergency contact, phone, DOB, NIC, or account id. */
export type PatientCardRow = {
  readonly id: string;
  readonly surname: string;
  readonly givenNames: string;
};
