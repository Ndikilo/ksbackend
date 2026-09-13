import { describe, expect, it } from "vitest";
import { offsetMeta, offsetOf } from "./offset";

describe("offset", () => {
  it("computes the SQL offset for a 1-based page", () => {
    expect(offsetOf(1, 20)).toBe(0);
    expect(offsetOf(3, 20)).toBe(40);
  });

  it("builds meta for a middle page", () => {
    expect(offsetMeta(2, 20, 137, 20)).toEqual({
      count: 20,
      page: 2,
      pageSize: 20,
      total: 137,
      pageCount: 7,
      hasNextPage: true,
      hasPreviousPage: true,
    });
  });

  it("flags the last page", () => {
    const meta = offsetMeta(7, 20, 137, 17);
    expect(meta.pageCount).toBe(7);
    expect(meta.hasNextPage).toBe(false);
    expect(meta.hasPreviousPage).toBe(true);
  });

  it("handles an empty result set", () => {
    expect(offsetMeta(1, 20, 0, 0)).toEqual({
      count: 0,
      page: 1,
      pageSize: 20,
      total: 0,
      pageCount: 0,
      hasNextPage: false,
      hasPreviousPage: false,
    });
  });

  it("handles a page beyond the last", () => {
    const meta = offsetMeta(999, 20, 40, 0);
    expect(meta.pageCount).toBe(2);
    expect(meta.hasNextPage).toBe(false);
    expect(meta.hasPreviousPage).toBe(true);
  });
});
