# Error codes

Every error response uses the standard envelope:

```jsonc
{ "error": { "code": "…", "message": "…", "details": [] }, "requestId": "…" }
```

`code` is stable and machine-readable — the frontend switches on it. It is decoupled from HTTP
status and from the human `message`. **Renaming a code is a breaking API change.** The mapping
from domain tagged error → `(status, code)` lives in one place: `src/http/error-mapper.ts`.

| Code                         | HTTP | Domain error                     | Meaning                                                                  |
| ---------------------------- | ---- | -------------------------------- | ------------------------------------------------------------------------ |
| `NOT_FOUND`                  | 404  | `NotFound`                       | Resource does not exist                                                  |
| `UNAUTHORIZED`               | 401  | `Unauthorized`                   | Authentication required / invalid                                        |
| `FORBIDDEN`                  | 403  | `Forbidden`                      | Authenticated but not allowed                                            |
| `CONFLICT`                   | 409  | `Conflict`                       | Duplicate / state conflict (incl. client-supplied id)                    |
| `VERIFICATION_STATE_INVALID` | 409  | `VerificationStateInvalid`       | Verification transition not allowed from the profile's current status    |
| `LICENCE_ALREADY_REGISTERED` | 409  | `LicenceAlreadyRegistered`       | CMC/NIC credentials already registered to another practitioner account   |
| `PROFILE_INCOMPLETE`         | 409  | `ProfileIncomplete`              | Action requires a profile section the user hasn't completed              |
| `FILE_INFECTED`              | 422  | `FileInfected`                   | Uploaded file failed the malware scan                                    |
| `FILE_SCAN_INCOMPLETE`       | 409  | `FileScanIncomplete`             | Scan hasn't reported `clean` yet — retryable, poll and re-submit         |
| `VALIDATION_FAILED`          | 422  | `ValidationFailed`               | Request failed schema/domain validation (`details` carries field issues) |
| `SLOT_OVERLAP`               | 409  | `SlotOverlap`                    | A published availability slot overlaps an existing one                   |
| `SLOT_TAKEN`                 | 409  | `SlotTaken`                      | The slot was just booked / is no longer bookable — pick another slot     |
| `APPOINTMENT_STATE_INVALID`  | 409  | `AppointmentStateInvalid`        | Appointment action not allowed from its current status                   |
| `APPOINTMENT_STARTED`        | 409  | `AppointmentStarted`             | The appointment's time has started — self-service changes are over       |
| `PAYLOAD_TOO_LARGE`          | 413  | _(bodyLimit middleware)_         | Request body exceeds the 1 MB limit                                      |
| `RATE_LIMITED`               | 429  | _(rate-limit middleware)_        | Too many requests (`Retry-After` header carries the wait in seconds)     |
| `INTERNAL`                   | 500  | _(any unhandled failure/defect)_ | Unexpected server error (cause logged with `requestId`)                  |

Add a new code by adding a tagged error in `src/domain/shared/errors.ts` (or a feature's
`domain/<feature>/errors.ts`) and a case in `src/http/error-mapper.ts`, then document it here.
