import { describe, expect, it } from "vitest";
import { decodeCursor, encodeCursor } from "./cursor";

describe("cursor", () => {
  it("round-trips an id and is opaque (not equal to the raw id)", () => {
    const id = "0189d4c2-7c6a-7b3e-8b2a-1c2d3e4f5a6b";
    const cursor = encodeCursor(id);
    expect(cursor).not.toBe(id);
    expect(decodeCursor(cursor)).toBe(id);
  });
});
