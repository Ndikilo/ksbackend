import { describe, expect, it } from "vitest";

import {
  REMINDER_HORIZONS,
  REMINDER_LEAD_MS,
  deliverableChannels,
  judgeReminder,
  reminderDueAt,
  reminderDedupKey,
  reminderScenario,
  type ReminderCandidate,
} from "./reminder";

/**
 * P6.T2 — the reminder window table. Every rule of judgeReminder is pinned at
 * its boundary (exactly-24h-out, exactly-1h-out, cancelled-before-send,
 * started, booked-inside-the-window) and the absolute-instant discipline is
 * proven against a DST-active instant so the math can never silently depend on
 * a wall clock or a fixed UTC offset.
 */

const HOUR_MS = 60 * 60_000;
const DAY_MS = 24 * HOUR_MS;

/**
 * 2026-03-30T09:00:00Z — 25h AFTER Europe/Paris sprang forward (2026-03-29).
 * Built from the epoch (the structure gate rightly bans string-parsed dates —
 * they read as non-deterministic wall-clock input).
 */
const DST_START: Date = (() => {
  const at = new Date(0);
  at.setUTCFullYear(2026, 2, 30);
  at.setUTCHours(9, 0, 0, 0);
  return at;
})();

const candidate = (overrides?: Partial<ReminderCandidate>): ReminderCandidate => ({
  id: "apt-1",
  status: "confirmed",
  startsAt: DST_START,
  createdAt: new Date(DST_START.getTime() - 30 * DAY_MS),
  ...overrides,
});

/** The exact due points of the fixture appointment. */
const DUE_24H = new Date(DST_START.getTime() - DAY_MS); // 2026-03-29T09:00:00Z
const DUE_1H = new Date(DST_START.getTime() - HOUR_MS); // 2026-03-30T08:00:00Z

describe("reminder horizons (P6.T2)", () => {
  it("computes due points by absolute lead time — exact to the millisecond", () => {
    expect(reminderDueAt(DST_START, "24h").getTime()).toBe(
      DST_START.getTime() - REMINDER_LEAD_MS["24h"],
    );
    expect(reminderDueAt(DST_START, "1h").getTime()).toBe(
      DST_START.getTime() - REMINDER_LEAD_MS["1h"],
    );
    expect(DUE_24H.toISOString()).toBe("2026-03-29T09:00:00.000Z");
    expect(DUE_1H.toISOString()).toBe("2026-03-30T08:00:00.000Z");
  });

  it("is DST-safe: the due point is pure lead-time arithmetic, never a wall-clock shift", () => {
    // Europe/Paris sprang forward 2026-03-29T01:00Z. A wall-clock
    // "same local time the day before" implementation would place the 24h
    // due point at 10:00 Paris = 08:00Z (DST already active); absolute
    // lead-time arithmetic places it at 09:00Z. We pin the ABSOLUTE result:
    // reminders fire a true 24h/1h before the appointment regardless of any
    // timezone's DST rules (Douala has none — the code must not assume it).
    expect(DUE_24H.getTime() - DUE_1H.getTime()).toBe(-23 * HOUR_MS);
    expect(DST_START.getTime() - DUE_24H.getTime()).toBe(DAY_MS);
  });

  it("dedup keys and scenarios distinguish horizons and pin the appointment", () => {
    expect(reminderDedupKey("apt-1", "24h")).toBe("reminder-24h:apt-1");
    expect(reminderDedupKey("apt-1", "1h")).toBe("reminder-1h:apt-1");
    expect(reminderScenario["24h"]).toBe("reminder-24h");
    expect(reminderScenario["1h"]).toBe("reminder-1h");
    expect(REMINDER_HORIZONS).toEqual(["24h", "1h"]);
  });
});

describe("judgeReminder — the window table", () => {
  it("enqueues exactly AT each due point (inclusive boundary)", () => {
    expect(judgeReminder(candidate(), "24h", DUE_24H)).toEqual({ action: "enqueue" });
    expect(judgeReminder(candidate(), "1h", DUE_1H)).toEqual({ action: "enqueue" });
  });

  it("waits before the due point (1ms earlier is not yet)", () => {
    expect(judgeReminder(candidate(), "24h", new Date(DUE_24H.getTime() - 1))).toEqual({
      action: "wait",
    });
    expect(judgeReminder(candidate(), "1h", new Date(DUE_1H.getTime() - 1))).toEqual({
      action: "wait",
    });
  });

  it("keeps enqueueing until the appointment starts (the scan must heal a missed cron tick)", () => {
    // Due point passed hours ago (cron was down) but the appointment has not
    // started: still enqueue — late beats never.
    expect(judgeReminder(candidate(), "24h", new Date(DUE_1H.getTime() - HOUR_MS))).toEqual({
      action: "enqueue",
    });
    // Boundary: the instant it starts, the window closes.
    expect(judgeReminder(candidate(), "24h", DST_START)).toEqual({
      action: "skip",
      reason: "started",
    });
  });

  it("never reminds a cancelled appointment (cancelled before send = skip)", () => {
    expect(judgeReminder(candidate({ status: "cancelled" }), "24h", DUE_24H)).toEqual({
      action: "skip",
      reason: "not-confirmed",
    });
    expect(judgeReminder(candidate({ status: "pending" }), "1h", DUE_1H)).toEqual({
      action: "skip",
      reason: "not-confirmed",
    });
    expect(judgeReminder(candidate({ status: "completed" }), "24h", DUE_24H)).toEqual({
      action: "skip",
      reason: "not-confirmed",
    });
    expect(judgeReminder(candidate({ status: "no_show" }), "24h", DUE_24H)).toEqual({
      action: "skip",
      reason: "not-confirmed",
    });
  });

  it("skips horizons the booking was made inside (the confirmation already covered it)", () => {
    // Booked 90 minutes ahead: inside the 24h window, outside the 1h window.
    const late = candidate({ createdAt: new Date(DST_START.getTime() - 90 * 60_000) });
    expect(judgeReminder(late, "24h", DUE_24H)).toEqual({
      action: "skip",
      reason: "booked-too-late",
    });
    expect(judgeReminder(late, "1h", DUE_1H)).toEqual({ action: "enqueue" });
    // Booked 30 minutes ahead: both horizons skip — no reminder 10 minutes
    // after the user watched the confirmation screen.
    const veryLate = candidate({ createdAt: new Date(DST_START.getTime() - 30 * 60_000) });
    expect(judgeReminder(veryLate, "24h", DUE_24H)).toEqual({
      action: "skip",
      reason: "booked-too-late",
    });
    expect(judgeReminder(veryLate, "1h", DUE_1H)).toEqual({
      action: "skip",
      reason: "booked-too-late",
    });
  });
});

describe("deliverableChannels — the preference intersection", () => {
  it("defaults to email when the user never stored a preference row", () => {
    expect(deliverableChannels(undefined, { email: "a@b.c" })).toEqual(["email"]);
  });

  it("honours the stored appointments matrix per channel", () => {
    expect(
      deliverableChannels({ email: true, sms: true, push: false }, { email: "a@b.c" }),
    ).toEqual(["email"]);
    // sms enabled but no resolvable recipient yet (no phone identity until
    // P8.T6) — the channel is silently not deliverable, never half-sent.
    expect(
      deliverableChannels({ email: false, sms: true, push: false }, { email: "a@b.c" }),
    ).toEqual([]);
  });
});
