export type ProfessionReference = {
  readonly id: string;
  readonly nameEn: string;
  readonly nameFr: string;
  readonly prefixHint: string | null;
};

export type LanguageReference = {
  readonly id: string;
  readonly code: string;
  readonly nameEn: string;
  readonly nameFr: string;
};
