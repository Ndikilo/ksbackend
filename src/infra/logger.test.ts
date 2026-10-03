import { describe, expect, it } from "vitest";
import { parseDrainHeaders } from "./logger";

describe("parseDrainHeaders", () => {
  it("returns no headers for empty or blank input", () => {
    expect(parseDrainHeaders("")).toStrictEqual({});
    expect(parseDrainHeaders("   ")).toStrictEqual({});
  });

  it("parses comma-separated Key=Value auth headers, keeping value separators", () => {
    expect(parseDrainHeaders("Authorization=Bearer abc")).toStrictEqual({
      Authorization: "Bearer abc",
    });
    expect(parseDrainHeaders("A=1,B=2=3")).toStrictEqual({ A: "1", B: "2=3" });
  });

  it("trims keys and values and skips empty or keyless parts", () => {
    expect(
      parseDrainHeaders(
        "  X-Axiom-Dataset = logs , , =novalue , noequals ,Authorization=Bearer t ",
      ),
    ).toStrictEqual({ "X-Axiom-Dataset": "logs", Authorization: "Bearer t" });
  });
});
