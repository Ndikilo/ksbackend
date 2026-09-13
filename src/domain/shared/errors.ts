import { Data } from "effect";

/**
 * Shared domain errors. Tagged errors ride the Effect error channel and are
 * mapped to HTTP responses (status + stable `code`) centrally in
 * src/http/error-mapper.ts; the `code` keys the localized message. Features may
 * reuse these or add their own in `domain/<feature>/errors.ts`.
 *
 * Pure domain values — no HTTP/framework imports.
 */
export class NotFound extends Data.TaggedError("NotFound")<{
  readonly resource: string;
  readonly id?: string;
}> {}

export class Unauthorized extends Data.TaggedError("Unauthorized")<{
  readonly reason?: string;
}> {}

export class Forbidden extends Data.TaggedError("Forbidden")<{
  readonly reason?: string;
}> {}

export class Conflict extends Data.TaggedError("Conflict")<{
  readonly resource: string;
  readonly reason?: string;
}> {}

export class ValidationFailed extends Data.TaggedError("ValidationFailed")<{
  readonly issues: ReadonlyArray<{ readonly path: string; readonly message: string }>;
}> {}

/** A practitioner's licence/ID number is already registered to another account. */
export class LicenceAlreadyRegistered extends Data.TaggedError("LicenceAlreadyRegistered")<{
  readonly field: string;
}> {}

/** An action requires a completed profile that the user hasn't submitted yet. */
export class ProfileIncomplete extends Data.TaggedError("ProfileIncomplete")<{
  readonly resource: string;
}> {}

/**
 * A verification-state-machine transition was attempted from a status that
 * doesn't allow it — e.g. approving a profile that never submitted credentials,
 * or re-submitting credentials on an already-verified profile. `current` is the
 * status the profile is actually in.
 */
export class VerificationStateInvalid extends Data.TaggedError("VerificationStateInvalid")<{
  readonly current: string;
}> {}

/** An uploaded file failed the malware scan. */
export class FileInfected extends Data.TaggedError("FileInfected")<{
  readonly key: string;
}> {}
