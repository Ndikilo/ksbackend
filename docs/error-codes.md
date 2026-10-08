# Error codes

Every error response uses the standard envelope:

```jsonc
{ "error": { "code": "…", "message": "…", "details": [] }, "requestId": "…" }
```

`code` is stable and machine-readable — the frontend switches on it. It is decoupled from HTTP
status and from the human `message`. **Renaming a code is a breaking API change.** The mapping
from domain tagged error → `(status, code)` lives in one place: `src/http/error-mapper.ts`.

| Code                           | HTTP | Domain error                     | Meaning                                                                  |
| ------------------------------ | ---- | -------------------------------- | ------------------------------------------------------------------------ |
| `NOT_FOUND`                    | 404  | `NotFound`                       | Resource does not exist                                                  |
| `UNAUTHORIZED`                 | 401  | `Unauthorized`                   | Authentication required / invalid                                        |
| `FORBIDDEN`                    | 403  | `Forbidden`                      | Authenticated but not allowed                                            |
| `CONFLICT`                     | 409  | `Conflict`                       | Duplicate / state conflict (incl. client-supplied id)                    |
| `VERIFICATION_STATE_INVALID`   | 409  | `VerificationStateInvalid`       | Verification transition not allowed from the profile's current status    |
| `LICENCE_ALREADY_REGISTERED`   | 409  | `LicenceAlreadyRegistered`       | CMC/NIC credentials already registered to another practitioner account   |
| `PROFILE_INCOMPLETE`           | 409  | `ProfileIncomplete`              | Action requires a profile section the user hasn't completed              |
| `FILE_INFECTED`                | 422  | `FileInfected`                   | Uploaded file failed the malware scan                                    |
| `FILE_SCAN_INCOMPLETE`         | 409  | `FileScanIncomplete`             | Scan hasn't reported `clean` yet — retryable, poll and re-submit         |
| `VALIDATION_FAILED`            | 422  | `ValidationFailed`               | Request failed schema/domain validation (`details` carries field issues) |
| `SLOT_OVERLAP`                 | 409  | `SlotOverlap`                    | A published availability slot overlaps an existing one                   |
| `SLOT_TAKEN`                   | 409  | `SlotTaken`                      | The slot was just booked / is no longer bookable — pick another slot     |
| `APPOINTMENT_STATE_INVALID`    | 409  | `AppointmentStateInvalid`        | Appointment action not allowed from its current status                   |
| `APPOINTMENT_STARTED`          | 409  | `AppointmentStarted`             | The appointment's time has started — self-service changes are over       |
| `PAYMENT_STATE_INVALID`        | 409  | `PaymentStateInvalid`            | Payment action not allowed from the charge's current status              |
| `PAYMENT_DECLINED`             | 402  | `PaymentDeclined`                | The wallet/provider refused the charge — retry or switch rail            |
| `PAYMENT_PROVIDER_UNAVAILABLE` | 503  | `PaymentProviderUnavailable`     | Provider unreachable/misconfigured — nothing charged, retry later        |
| `WEBHOOK_SIGNATURE_INVALID`    | 401  | `WebhookSignatureInvalid`        | Webhook HMAC missing/malformed/mismatching — payload never processed     |
| `OTP_INVALID`                  | 401  | `OtpInvalid`                     | Wrong phone-OTP code (`details` carries the remaining attempts)          |
| `OTP_EXPIRED`                  | 409  | `OtpExpired`                     | No live phone-OTP code for this phone, or its TTL elapsed                |
| `OTP_ALREADY_USED`             | 409  | `OtpAlreadyUsed`                 | The phone-OTP code was already consumed — codes are single-use           |
| `OTP_LOCKED`                   | 429  | `OtpLocked`                      | Phone locked after too many wrong codes (`details` carries the wait)     |
| `OTP_RESEND_COOLDOWN`          | 429  | `OtpResendTooSoon`               | A code was sent too recently — wait for the 60s cooldown                 |
| `OTP_SEND_THROTTLED`           | 429  | `OtpSendThrottled`               | Per-phone or per-IP OTP send budget spent for the window                 |
| `OTP_DELIVERY_UNAVAILABLE`     | 503  | `OtpDeliveryUnavailable`         | No OTP channel configured (prod/staging) or the provider failed          |
| `PHONE_ALREADY_VERIFIED`       | 409  | `PhoneAlreadyVerified`           | The phone is already a verified identity of another account              |
| `PAYLOAD_TOO_LARGE`            | 413  | _(bodyLimit middleware)_         | Request body exceeds the 1 MB limit                                      |
| `RATE_LIMITED`                 | 429  | _(rate-limit middleware)_        | Too many requests (`Retry-After` header carries the wait in seconds)     |
| `INTERNAL`                     | 500  | _(any unhandled failure/defect)_ | Unexpected server error (cause logged with `requestId`)                  |

Add a new code by adding a tagged error in `src/domain/shared/errors.ts` (or a feature's
`domain/<feature>/errors.ts`) and a case in `src/http/error-mapper.ts`, then document it here.
