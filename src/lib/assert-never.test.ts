import { describe, expect, it } from "vitest";
import { assertNever } from "./assert-never";

describe("assertNever", () => {
  it("throws when an impossible value is reached at runtime", () => {
    // @ts-expect-error — deliberately passing a value to the `never` parameter.
    expect(() => assertNever("unexpected")).toThrow("Unhandled case");
  });
});
