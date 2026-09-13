import { Data } from "effect";

/** A new slot overlaps an existing active slot for the same practitioner. */
export class SlotOverlap extends Data.TaggedError("SlotOverlap")<Record<string, never>> {}
