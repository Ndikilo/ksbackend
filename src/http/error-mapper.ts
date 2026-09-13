import { Cause, Option } from "effect";
import type { Context } from "hono";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import { SlotOverlap } from "@/domain/availability/errors";
import { ReviewNotEligible } from "@/domain/review/errors";
import {
  Conflict,
  FileInfected,
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
    if (error instanceof SlotOverlap) {
      return { status: 409, code: "SLOT_OVERLAP", params: {}, details: [] };
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
