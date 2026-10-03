import { Data } from "effect";

/**
 * The slot is no longer bookable — another booking won it (active appointment
 * exists) or the practitioner published-then-cancelled it. Retryable: pick
 * another slot. The concurrency loser of two bookings on the same slot gets
 * this error (P3.T2); maps to 409 SLOT_TAKEN.
 */
export class SlotTaken extends Data.TaggedError("SlotTaken")<Record<string, never>> {}
