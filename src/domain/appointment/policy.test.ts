import { describe, expect, it } from "vitest";

import {
  judgeCancellation,
  judgeReschedule,
  hasStarted,
  isActionableStatus,
  isLateCancellation,
} from "./policy";

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

  // The rules engine (P3.T5): the decision table the cancel endpoint applies.
  describe("judgeCancellation", () => {
    const appointment = {
      status: "confirmed" as const,
      startsAt: start,
      cancellationNoticeHours: 24,
      cancellationFeeXaf: 2500,
    };

    it("rejects non-actionable states (already-cancelled, completed, no_show) with the current status", () => {
      for (const status of ["cancelled", "completed", "no_show"] as const) {
        const judgement = judgeCancellation(
          { ...appointment, status },
          new Date(start.getTime() - 48 * HOUR),
          true,
        );
        expect(judgement).toEqual({ kind: "not-actionable", current: status });
      }
      // pending/confirmed reach the window judgement instead.
      expect(
        judgeCancellation(
          { ...appointment, status: "pending" },
          new Date(start.getTime() - 48 * HOUR),
          true,
        ).kind,
      ).toBe("on-time");
    });

    it("rejects past slots — the judgement flips exactly at the start time", () => {
      // 1ms before the start but INSIDE the 24h window → late, not started.
      expect(judgeCancellation(appointment, new Date(start.getTime() - 1), true).kind).toBe("late");
      // From the start time on, the state no longer matters — it's "started".
      expect(judgeCancellation(appointment, start, true).kind).toBe("started");
      expect(judgeCancellation(appointment, new Date(start.getTime() + HOUR), true).kind).toBe(
        "started",
      );
    });

    it("is on-time outside the window and late inside, carrying the snapshot fee", () => {
      expect(judgeCancellation(appointment, new Date(start.getTime() - 24 * HOUR), true)).toEqual({
        kind: "on-time",
      });
      expect(
        judgeCancellation(appointment, new Date(start.getTime() - 24 * HOUR + 1), true),
      ).toEqual({
        kind: "late",
        feeXaf: 2500,
      });
    });

    it("honours the practitioner-configured window: 0h never late, small windows bite late", () => {
      const lax = { ...appointment, cancellationNoticeHours: 0 };
      expect(judgeCancellation(lax, new Date(start.getTime() - 1), true).kind).toBe("on-time");
      // 1h window: 90 and 61 minutes remaining are OUTSIDE it, 59 inside.
      const strict = { ...appointment, cancellationNoticeHours: 1 };
      expect(judgeCancellation(strict, new Date(start.getTime() - 90 * 60_000), true).kind).toBe(
        "on-time",
      );
      expect(judgeCancellation(strict, new Date(start.getTime() - 61 * 60_000), true).kind).toBe(
        "on-time",
      );
      expect(judgeCancellation(strict, new Date(start.getTime() - 59 * 60_000), true).kind).toBe(
        "late",
      );
    });

    it("never marks a practitioner-initiated cancellation late, even inside the window", () => {
      expect(
        judgeCancellation(appointment, new Date(start.getTime() - 30 * 60_000), false),
      ).toEqual({
        kind: "on-time",
      });
    });
  });

  describe("judgeReschedule", () => {
    const appointment = { status: "confirmed" as const, startsAt: start };

    it("allows actionable, not-yet-started appointments — the window does not gate moving", () => {
      expect(judgeReschedule(appointment, new Date(start.getTime() - 30 * 60_000))).toEqual({
        kind: "allowed",
      });
      expect(
        judgeReschedule(
          { ...appointment, status: "pending" },
          new Date(start.getTime() - 30 * 60_000),
        ),
      ).toEqual({
        kind: "allowed",
      });
    });

    it("rejects cancelled/completed/no_show with the current status and past slots as started", () => {
      for (const status of ["cancelled", "completed", "no_show"] as const) {
        expect(
          judgeReschedule({ ...appointment, status }, new Date(start.getTime() - 48 * HOUR)),
        ).toEqual({
          kind: "not-actionable",
          current: status,
        });
      }
      expect(judgeReschedule(appointment, start).kind).toBe("started");
    });
  });
});
