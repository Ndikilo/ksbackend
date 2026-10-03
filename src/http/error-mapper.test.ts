import { Cause } from "effect";
import { describe, expect, it } from "vitest";
import {
  AppointmentStarted,
  AppointmentStateInvalid,
  SlotTaken,
} from "@/domain/appointment/errors";
import {
  Conflict,
  LicenceAlreadyRegistered,
  NotFound,
  Unauthorized,
  ValidationFailed,
} from "@/domain/shared/errors";
import { causeToError } from "./error-mapper";

// Behavior test: given a domain failure, we get the right (status, code, params).
describe("causeToError", () => {
  it("maps NotFound -> 404 NOT_FOUND with a resource param", () => {
    const mapped = causeToError(Cause.fail(new NotFound({ resource: "User", id: "1" })));
    expect(mapped.status).toBe(404);
    expect(mapped.code).toBe("NOT_FOUND");
    expect(mapped.params.resource).toBe("User");
  });

  it("maps Unauthorized -> 401, Conflict -> 409, Licence -> 409", () => {
    expect(causeToError(Cause.fail(new Unauthorized({}))).status).toBe(401);
    expect(causeToError(Cause.fail(new Conflict({ resource: "Email" }))).code).toBe("CONFLICT");
    expect(causeToError(Cause.fail(new LicenceAlreadyRegistered({ field: "cmc" }))).code).toBe(
      "LICENCE_ALREADY_REGISTERED",
    );
  });

  it("maps ValidationFailed -> 422 and carries issue details", () => {
    const mapped = causeToError(
      Cause.fail(new ValidationFailed({ issues: [{ path: "email", message: "invalid" }] })),
    );
    expect(mapped.status).toBe(422);
    expect(mapped.details).toEqual([{ path: "email", message: "invalid" }]);
  });

  it("maps SlotTaken -> 409 SLOT_TAKEN (the booking concurrency loser, P3.T2)", () => {
    const mapped = causeToError(Cause.fail(new SlotTaken({})));
    expect(mapped.status).toBe(409);
    expect(mapped.code).toBe("SLOT_TAKEN");
    expect(mapped.params).toEqual({});
  });

  it("maps appointment policy violations to stable 409 codes (P3.T3)", () => {
    const state = causeToError(Cause.fail(new AppointmentStateInvalid({ current: "cancelled" })));
    expect(state.status).toBe(409);
    expect(state.code).toBe("APPOINTMENT_STATE_INVALID");
    expect(state.params).toEqual({ current: "cancelled" });

    const started = causeToError(Cause.fail(new AppointmentStarted({})));
    expect(started.status).toBe(409);
    expect(started.code).toBe("APPOINTMENT_STARTED");
    expect(started.params).toEqual({});
  });

  it("maps unknown failures and defects to 500 INTERNAL", () => {
    expect(causeToError(Cause.fail(new Error("boom"))).code).toBe("INTERNAL");
    expect(causeToError(Cause.die("kaboom")).status).toBe(500);
  });
});
