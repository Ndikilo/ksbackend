import { Cause } from "effect";
import { describe, expect, it } from "vitest";
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

  it("maps unknown failures and defects to 500 INTERNAL", () => {
    expect(causeToError(Cause.fail(new Error("boom"))).code).toBe("INTERNAL");
    expect(causeToError(Cause.die("kaboom")).status).toBe(500);
  });
});
