import type { ConsultationType } from "./practitioner";

/**
 * Allow-list of sort keys for practitioner discovery. A `const` tuple so the
 * contract can feed it straight to `z.enum(...)` — validation there yields this
 * exact union with no cast, and the repo maps each field to an ORDER BY clause.
 */
export const PRACTITIONER_SORT_FIELDS = [
  "availability",
  "distance",
  "rating",
  "fee",
  "experience",
  "name",
  "recency",
] as const;
export type PractitionerSortField = (typeof PRACTITIONER_SORT_FIELDS)[number];

export type SortDirection = "asc" | "desc";
export type PractitionerSort = {
  readonly field: PractitionerSortField;
  readonly direction: SortDirection;
};

/** The natural direction applied when the client omits `order`. */
export const PRACTITIONER_SORT_DEFAULT_DIRECTION = {
  availability: "asc",
  distance: "asc",
  rating: "desc",
  fee: "asc",
  experience: "desc",
  name: "asc",
  recency: "desc",
} satisfies Record<PractitionerSortField, SortDirection>;

/** The searcher's location, used to compute + sort by distance. */
export type GeoPoint = { readonly latitude: number; readonly longitude: number };

/** Every filter is optional and independent — so they combine and clear freely. */
export type PractitionerSearchCriteria = {
  readonly specialty?: string | undefined;
  readonly city?: string | undefined;
  readonly language?: string | undefined;
  readonly consultationTypes?: ReadonlyArray<ConsultationType> | undefined;
  readonly feeMin?: number | undefined;
  readonly feeMax?: number | undefined;
  readonly professionId?: string | undefined;
  readonly q?: string | undefined;
  readonly origin?: GeoPoint | undefined;
};

/** The lightweight card projection the repo returns (photo is presigned by the service). */
export type PractitionerCardRow = {
  readonly id: string;
  readonly professionId: string;
  readonly professionNameEn: string;
  readonly professionNameFr: string;
  readonly professionPrefixHint: string | null;
  readonly prefix: string | null;
  readonly surname: string;
  readonly givenNames: string;
  readonly specialty: string | null;
  readonly location: string | null;
  readonly consultationTypes: ReadonlyArray<ConsultationType> | null;
  readonly languagesSpoken: ReadonlyArray<string> | null;
  readonly consultationFeeXaf: number | null;
  readonly ratingAverage: number;
  readonly ratingCount: number;
  readonly nextAvailableAt: Date | null;
  readonly distanceKm: number | null;
  readonly profilePhotoFileKey: string | null;
};
