import { describe, expect, it } from "vitest";

import { OUTBOX_MAX_ATTEMPTS, OUTBOX_MAX_RETRY_MS, failureOutcome, retryDelayMs } from "./outbox";

/**
 * The retry schedule is a MONEY-ADJACENT policy (a stuck reminder storms the
 * provider or silently dies) — pinned as a table so a change is a decision,
 * not an accident. Every test here can fail for the exact reason it claims.
 */
describe("outbox retry policy (pure)", () => {
  it("backs off exponentially: 1 min → 2 min → 4 min → 8 min, capped at 1 hour", () => {
    expect(retryDelayMs(1)).toBe(60_000);
    expect(retryDelayMs(2)).toBe(120_000);
    expect(retryDelayMs(3)).toBe(240_000);
    expect(retryDelayMs(4)).toBe(480_000);
    // The cap bites before the budget does: attempt 9 would naively be
    // 60_000 * 2^8 = 4h27m — it must clamp to OUTBOX_MAX_RETRY_MS.
    expect(retryDelayMs(9)).toBe(OUTBOX_MAX_RETRY_MS);
    expect(retryDelayMs(50)).toBe(OUTBOX_MAX_RETRY_MS);
  });

  it("attempt 1 never waits zero (an immediate hammer of a downed provider)", () => {
    expect(retryDelayMs(1)).toBeGreaterThan(0);
  });

  it("the retry budget gives OUTBOX_MAX_ATTEMPTS tries, then kills the row", () => {
    // Within budget: `failed` + a backoff availability (still eligible).
    expect(failureOutcome(1)).toEqual({ status: "failed", availableAt: "backoff" });
    expect(failureOutcome(OUTBOX_MAX_ATTEMPTS - 1)).toEqual({
      status: "failed",
      availableAt: "backoff",
    });
    // Budget exhausted (the 5th failure): terminal `dead`, never scheduled.
    expect(failureOutcome(OUTBOX_MAX_ATTEMPTS)).toEqual({ status: "dead", availableAt: "none" });
    expect(failureOutcome(OUTBOX_MAX_ATTEMPTS + 3)).toEqual({
      status: "dead",
      availableAt: "none",
    });
  });

  it("a dead row and a sent row are both terminal (the drain never re-claims them)", async () => {
    const { OUTBOX_TERMINAL_STATUSES } = await import("./outbox");
    expect(OUTBOX_TERMINAL_STATUSES.has("sent")).toBe(true);
    expect(OUTBOX_TERMINAL_STATUSES.has("dead")).toBe(true);
    expect(OUTBOX_TERMINAL_STATUSES.has("failed")).toBe(false);
    expect(OUTBOX_TERMINAL_STATUSES.has("pending")).toBe(false);
    expect(OUTBOX_TERMINAL_STATUSES.has("sending")).toBe(false);
  });
});
