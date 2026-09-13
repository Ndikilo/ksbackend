/** A patient's rating + optional comment for a practitioner. */
export type Review = {
  readonly id: string;
  readonly practitionerProfileId: string;
  readonly reviewerUserId: string;
  readonly reviewerName: string | null;
  readonly verifiedAppointment: boolean;
  readonly rating: number;
  readonly comment: string | null;
  readonly createdAt: Date;
  readonly updatedAt: Date;
};

/** What a patient submits (create or update their single active review). */
export type ReviewInput = {
  readonly rating: number;
  readonly comment?: string | undefined;
};

export const REVIEW_SORTS = ["newest", "highest", "lowest"] as const;
export type ReviewSort = (typeof REVIEW_SORTS)[number];

export type ReviewSummary = {
  readonly average: number;
  readonly count: number;
  readonly distribution: {
    readonly 1: number;
    readonly 2: number;
    readonly 3: number;
    readonly 4: number;
    readonly 5: number;
  };
};
