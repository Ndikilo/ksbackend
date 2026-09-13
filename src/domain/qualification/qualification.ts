export const QUALIFICATION_KINDS = [
  "degree",
  "specialisation",
  "certification",
  "training",
  "award",
] as const;

export type QualificationKind = (typeof QUALIFICATION_KINDS)[number];

export type Qualification = {
  readonly id: string;
  readonly practitionerProfileId: string;
  readonly kind: QualificationKind;
  readonly title: string;
  readonly institution: string;
  readonly country: string;
  readonly year: number;
  readonly sortOrder: number;
  readonly verifiedAt: Date | null;
};

export type QualificationInput = Omit<Qualification, "id" | "practitionerProfileId" | "verifiedAt">;
export type QualificationCreateInput = QualificationInput & { readonly id?: string | undefined };
export type QualificationPatch = {
  readonly kind?: QualificationKind | undefined;
  readonly title?: string | undefined;
  readonly institution?: string | undefined;
  readonly country?: string | undefined;
  readonly year?: number | undefined;
  readonly sortOrder?: number | undefined;
};
