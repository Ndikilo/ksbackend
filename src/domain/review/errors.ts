import { Data } from "effect";

export class ReviewNotEligible extends Data.TaggedError("ReviewNotEligible")<{
  readonly practitionerProfileId: string;
}> {}
