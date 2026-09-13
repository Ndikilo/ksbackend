import type { Relationship } from "@/domain/dependent/dependent";

export type LinkStatus = "pending" | "active" | "revoked" | "declined";

/** A caregiver↔account-holder link, from either party's perspective. */
export type CaregiverLinkView = {
  readonly id: string;
  readonly caregiverUserId: string;
  readonly subjectUserId: string | null;
  readonly inviteIdentifier: string | null;
  readonly relationship: Relationship;
  readonly status: LinkStatus;
  /** "sent" if the current user is the caregiver, "received" if the invitee. */
  readonly direction: "sent" | "received";
};

/**
 * A page of caregiver links (standard `{ data, meta }` list envelope).
 */
export type CaregiverLinkPage = {
  readonly data: ReadonlyArray<CaregiverLinkView>;
  readonly meta: {
    readonly count: number;
    readonly limit: number;
    readonly nextCursor: string | null;
    readonly hasNextPage: boolean;
  };
};
