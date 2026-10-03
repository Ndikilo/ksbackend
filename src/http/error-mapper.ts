import { Cause, Option } from "effect";
import type { Context } from "hono";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import { SlotOverlap } from "@/domain/availability/errors";
import {
  AppointmentStarted,
  AppointmentStateInvalid,
  SlotTaken,
} from "@/domain/appointment/errors";
import {
  PaymentDeclined,
  PaymentProviderUnavailable,
  PaymentStateInvalid,
  WebhookSignatureInvalid,
} from "@/domain/payment/errors";
import { ReviewNotEligible } from "@/domain/review/errors";
import {
  Conflict,
  FileInfected,
  FileScanIncomplete,
  Forbidden,
  LicenceAlreadyRegistered,
  NotFound,
  ProfileIncomplete,
  Unauthorized,
  ValidationFailed,
  VerificationStateInvalid,
} from "@/domain/shared/errors";
import { translate } from "@/infra/i18n";
import type { AppEnv } from "./app-env";

export type MappedError = {
  readonly status: ContentfulStatusCode;
  readonly code: string;
  readonly params: Record<string, string | number>;
  readonly details: ReadonlyArray<unknown>;
};

/**
 * The single place domain errors become HTTP status + stable `code` (+ params
 * for message interpolation). Pure and unit-tested. Unknown failures/defects map
 * to 500. `instanceof` narrows the tagged-error type — no casting.
 */
export const causeToError = (cause: Cause.Cause<unknown>): MappedError => {
  const failure = Cause.failureOption(cause);
  if (Option.isSome(failure)) {
    const error = failure.value;
    if (error instanceof NotFound) {
      return { status: 404, code: "NOT_FOUND", params: { resource: error.resource }, details: [] };
    }
    if (error instanceof Unauthorized) {
      return { status: 401, code: "UNAUTHORIZED", params: {}, details: [] };
    }
    if (error instanceof Forbidden) {
      return { status: 403, code: "FORBIDDEN", params: {}, details: [] };
    }
    if (error instanceof ReviewNotEligible) {
      return { status: 403, code: "REVIEW_NOT_ELIGIBLE", params: {}, details: [] };
    }
    if (error instanceof Conflict) {
      return { status: 409, code: "CONFLICT", params: { resource: error.resource }, details: [] };
    }
    if (error instanceof LicenceAlreadyRegistered) {
      return { status: 409, code: "LICENCE_ALREADY_REGISTERED", params: {}, details: [] };
    }
    if (error instanceof ProfileIncomplete) {
      return {
        status: 409,
        code: "PROFILE_INCOMPLETE",
        params: { resource: error.resource },
        details: [],
      };
    }
    if (error instanceof VerificationStateInvalid) {
      return {
        status: 409,
        code: "VERIFICATION_STATE_INVALID",
        params: { current: error.current },
        details: [],
      };
    }
    if (error instanceof FileInfected) {
      return { status: 422, code: "FILE_INFECTED", params: {}, details: [] };
    }
    if (error instanceof FileScanIncomplete) {
      // Retryable: the scan hasn't reported clean yet (pending/unscanned/lookup
      // error). 409 + Retry-After tells the client to poll and re-submit later.
      return { status: 409, code: "FILE_SCAN_INCOMPLETE", params: {}, details: [] };
    }
    if (error instanceof SlotOverlap) {
      return { status: 409, code: "SLOT_OVERLAP", params: {}, details: [] };
    }
    if (error instanceof SlotTaken) {
      // The concurrency loser of two bookings on one slot (P3.T2). Retryable:
      // pick another slot.
      return { status: 409, code: "SLOT_TAKEN", params: {}, details: [] };
    }
    if (error instanceof AppointmentStateInvalid) {
      // A cancel/reschedule attempted from a status that forbids it (P3.T3).
      return {
        status: 409,
        code: "APPOINTMENT_STATE_INVALID",
        params: { current: error.current },
        details: [],
      };
    }
    if (error instanceof AppointmentStarted) {
      // The appointment's time has started — self-service changes are over.
      return { status: 409, code: "APPOINTMENT_STARTED", params: {}, details: [] };
    }
    if (error instanceof PaymentStateInvalid) {
      // A payment action attempted from a status that forbids it — re-paying a
      // succeeded charge, refunding a failed one (P5.T3).
      return {
        status: 409,
        code: "PAYMENT_STATE_INVALID",
        params: { current: error.current },
        details: [],
      };
    }
    if (error instanceof PaymentDeclined) {
      // The wallet/provider refused the charge — the patient can retry with
      // the same or another rail (P5.T3).
      return { status: 402, code: "PAYMENT_DECLINED", params: {}, details: [] };
    }
    if (error instanceof PaymentProviderUnavailable) {
      // Provider unreachable/misconfigured/uncontractual — nothing was decided
      // about the money; the charge stays initiated and the call is retryable.
      return { status: 503, code: "PAYMENT_PROVIDER_UNAVAILABLE", params: {}, details: [] };
    }
    if (error instanceof WebhookSignatureInvalid) {
      // Fail-closed webhook auth: missing/malformed/mismatching HMAC — the
      // payload was never processed (P5.T3).
      return { status: 401, code: "WEBHOOK_SIGNATURE_INVALID", params: {}, details: [] };
    }
    if (error instanceof ValidationFailed) {
      return { status: 422, code: "VALIDATION_FAILED", params: {}, details: error.issues };
    }
  }
  return { status: 500, code: "INTERNAL", params: {}, details: [] };
};

/** Build the standard, localized error response, logging the full cause on 5xx. */
export const toErrorResponse = (c: Context<AppEnv>, cause: Cause.Cause<unknown>): Response => {
  const mapped = causeToError(cause);
  const locale = c.get("locale") ?? "en";
  if (mapped.status >= 500) {
    console.error(`[${c.get("requestId")}]`, Cause.pretty(cause));
  }
  return c.json(
    {
      error: {
        code: mapped.code,
        message: translate(locale, `errors.${mapped.code}`, mapped.params),
        details: mapped.details,
      },
      requestId: c.get("requestId"),
    },
    mapped.status,
  );
};
