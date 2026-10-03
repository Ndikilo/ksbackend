import { describe, expect, it } from "vitest";

import { hasStarted, isActionableStatus, isLateCancellation } from "./policy";

// Boundary table for the pure cancellation policy. Each row names a production
// change that would turn it red: the cutoff math (<= vs <), the start-time
// comparison, the 0-hour special case, and the actionable status set.
describe("appointment cancellation policy (pure)", () => {
  const start = new Date(Date.parse("2026-06-15T09:00:00.000Z"));
  const HOUR = 3_600_000;

  describe("isLateCancellation", () => {
    it("is on time strictly outside the notice window, late strictly inside", () => {
      // 24h window: 24h + 1ms remaining → on time.
      expect(isLateCancellation(start, 24, new Date(start.getTime() - 24 * HOUR - 1))).toBe(false);
      // Exactly at the cutoff (24h remaining) → on time (inclusive boundary).
      expect(isLateCancellation(start, 24, new Date(start.getTime() - 24 * HOUR))).toBe(false);
      // 1ms inside the window → late.
      expect(isLateCancellation(start, 24, new Date(start.getTime() - 24 * HOUR + 1))).toBe(true);
      // Well inside → late.
      expect(isLateCancellation(start, 24, new Date(start.getTime() - 30 * 60_000))).toBe(true);
    });

    it("treats a 0-hour window as never late before the start", () => {
      expect(isLateCancellation(start, 0, new Date(start.getTime() - 1))).toBe(false);
      expect(isLateCancellation(start, 0, new Date(start.getTime() - 24 * HOUR))).toBe(false);
    });
  });

  describe("hasStarted", () => {
    it("flips exactly at the start time", () => {
      expect(hasStarted(start, new Date(start.getTime() - 1))).toBe(false);
      expect(hasStarted(start, start)).toBe(true);
      expect(hasStarted(start, new Date(start.getTime() + HOUR))).toBe(true);
    });
  });

  describe("isActionableStatus", () => {
    it("allows pending and confirmed only — a production change to the value set turns these red", () => {
      expect(isActionableStatus("pending")).toBe(true);
      expect(isActionableStatus("confirmed")).toBe(true);
      expect(isActionableStatus("cancelled")).toBe(false);
      expect(isActionableStatus("completed")).toBe(false);
      expect(isActionableStatus("no_show")).toBe(false);
    });
  });
});
