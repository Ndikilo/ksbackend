import { describe, expect, it } from "vitest";
import type {
  AvailabilityException,
  AvailabilityRule,
  AvailabilitySlot,
} from "@/domain/availability/availability";
import { expandSchedule } from "@/domain/availability/schedule";

const instant = (value: string): Date => new Date(Date.parse(value));
const rule = (patch?: Partial<AvailabilityRule>): AvailabilityRule => ({
  id: "00000000-0000-4000-8000-000000000001",
  practitionerProfileId: "00000000-0000-4000-8000-000000000002",
  weekday: 1,
  startTime: "09:00",
  endTime: "11:00",
  slotDurationMin: 30,
  consultationTypes: ["in_person"],
  locationId: null,
  timezone: "Africa/Douala",
  validFrom: null,
  validTo: null,
  ...patch,
});
const exception = (patch?: Partial<AvailabilityException>): AvailabilityException => ({
  id: "00000000-0000-4000-8000-000000000003",
  practitionerProfileId: "00000000-0000-4000-8000-000000000002",
  date: "2026-08-31",
  kind: "blocked",
  startTime: null,
  endTime: null,
  consultationTypes: null,
  locationId: null,
  ...patch,
});
const explicit = (patch?: Partial<AvailabilitySlot>): AvailabilitySlot => ({
  id: "00000000-0000-4000-8000-000000000004",
  practitionerProfileId: "00000000-0000-4000-8000-000000000002",
  startsAt: instant("2026-08-31T08:30:00.000Z"),
  endsAt: instant("2026-08-31T09:00:00.000Z"),
  consultationTypes: ["video"],
  locationId: null,
  status: "open",
  ...patch,
});
const expand = (
  rules: ReadonlyArray<AvailabilityRule>,
  exceptions: ReadonlyArray<AvailabilityException> = [],
  explicitSlots: ReadonlyArray<AvailabilitySlot> = [],
) =>
  expandSchedule({
    rules,
    exceptions,
    explicitSlots,
    from: instant("2026-08-31T00:00:00.000Z"),
    to: instant("2026-09-01T00:00:00.000Z"),
    now: instant("2026-08-30T00:00:00.000Z"),
  });

describe("expandSchedule", () => {
  it("expands JavaScript weekdays in Africa/Douala and respects duration boundaries", () => {
    const slots = expand([rule()]);
    expect(slots.map((slot) => slot.startsAt.toISOString())).toEqual([
      "2026-08-31T08:00:00.000Z",
      "2026-08-31T08:30:00.000Z",
      "2026-08-31T09:00:00.000Z",
      "2026-08-31T09:30:00.000Z",
    ]);
  });

  it("applies whole-day and partial blocked exceptions", () => {
    expect(expand([rule()], [exception()])).toEqual([]);
    const partial = expand([rule()], [exception({ startTime: "09:30", endTime: "10:30" })]);
    expect(partial.map((slot) => slot.startsAt.toISOString())).toEqual([
      "2026-08-31T08:00:00.000Z",
      "2026-08-31T09:30:00.000Z",
    ]);
  });

  it("lets explicit slots override overlapping recurring slots", () => {
    const slots = expand([rule()], [], [explicit()]);
    expect(slots.map((slot) => slot.source)).toEqual(["rule", "explicit", "rule", "rule"]);
    expect(slots.map((slot) => slot.startsAt.toISOString())).toEqual([
      "2026-08-31T08:00:00.000Z",
      "2026-08-31T08:30:00.000Z",
      "2026-08-31T09:00:00.000Z",
      "2026-08-31T09:30:00.000Z",
    ]);
  });

  it("uses booked explicit rows to suppress generated availability", () => {
    const slots = expand(
      [rule()],
      [],
      [explicit({ startsAt: instant("2026-08-31T08:00:00.000Z"), status: "booked" })],
    );
    expect(slots.map((slot) => slot.startsAt.toISOString())).not.toContain(
      "2026-08-31T08:00:00.000Z",
    );
  });

  it("expands overnight ranges and excludes slots outside validity dates", () => {
    const overnight = expand([rule({ startTime: "22:00", endTime: "02:00", slotDurationMin: 60 })]);
    expect(overnight.map((slot) => slot.startsAt.toISOString())).toEqual([
      "2026-08-31T21:00:00.000Z",
      "2026-08-31T22:00:00.000Z",
      "2026-08-31T23:00:00.000Z",
    ]);
    expect(expand([rule({ validFrom: "2026-09-01" })])).toEqual([]);
    expect(expand([rule({ validTo: "2026-08-30" })])).toEqual([]);
  });
});
