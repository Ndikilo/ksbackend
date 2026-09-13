import type {
  AvailabilityException,
  AvailabilityRule,
  AvailabilitySlot,
  PublicAvailabilitySlot,
} from "./availability";

const DOUALA_OFFSET_MINUTES = 60;

const dateAtTime = (date: string, time: string): Date => {
  const [hours = 0, minutes = 0] = time.split(":").map(Number);
  const midnight = Date.parse(`${date}T00:00:00.000Z`);
  return new Date(midnight + (hours * 60 + minutes - DOUALA_OFFSET_MINUTES) * 60_000);
};

const dateKey = (instant: Date): string =>
  new Date(instant.getTime() + DOUALA_OFFSET_MINUTES * 60_000).toISOString().slice(0, 10);

const weekday = (date: string): number => new Date(Date.parse(`${date}T00:00:00.000Z`)).getUTCDay();

const endAtTime = (date: string, startTime: string, endTime: string): Date => {
  const end = dateAtTime(date, endTime);
  return endTime > startTime ? end : new Date(end.getTime() + 86_400_000);
};

const intersects = (aStart: Date, aEnd: Date, bStart: Date, bEnd: Date): boolean =>
  aStart.getTime() < bEnd.getTime() && aEnd.getTime() > bStart.getTime();

const datesBetween = (from: Date, to: Date): ReadonlyArray<string> => {
  const result: string[] = [];
  const first = Date.parse(`${dateKey(from)}T00:00:00.000Z`);
  const last = Date.parse(`${dateKey(to)}T00:00:00.000Z`);
  for (let cursor = first; cursor <= last; cursor += 86_400_000) {
    result.push(new Date(cursor).toISOString().slice(0, 10));
  }
  return result;
};

export type ExpandScheduleInput = {
  readonly rules: ReadonlyArray<AvailabilityRule>;
  readonly exceptions: ReadonlyArray<AvailabilityException>;
  readonly explicitSlots: ReadonlyArray<AvailabilitySlot>;
  readonly from: Date;
  readonly to: Date;
  readonly now: Date;
};

/** Expand the persisted schedule into canonical, non-overlapping patient-visible slots. */
export const expandSchedule = (
  input: ExpandScheduleInput,
): ReadonlyArray<PublicAvailabilitySlot> => {
  const generated: PublicAvailabilitySlot[] = [];
  for (const date of datesBetween(input.from, input.to)) {
    const exceptions = input.exceptions.filter((item) => item.date === date);
    const blocked = exceptions.filter((item) => item.kind === "blocked");
    for (const rule of input.rules) {
      if (rule.weekday !== weekday(date)) continue;
      if (rule.validFrom !== null && date < rule.validFrom) continue;
      if (rule.validTo !== null && date > rule.validTo) continue;
      const windowStart = dateAtTime(date, rule.startTime);
      const windowEnd = endAtTime(date, rule.startTime, rule.endTime);
      for (
        let startsAt = windowStart;
        startsAt.getTime() + rule.slotDurationMin * 60_000 <= windowEnd.getTime();
        startsAt = new Date(startsAt.getTime() + rule.slotDurationMin * 60_000)
      ) {
        const endsAt = new Date(startsAt.getTime() + rule.slotDurationMin * 60_000);
        const isBlocked = blocked.some((item) => {
          if (item.startTime === null || item.endTime === null) return true;
          return intersects(
            startsAt,
            endsAt,
            dateAtTime(date, item.startTime),
            dateAtTime(date, item.endTime),
          );
        });
        if (!isBlocked) {
          generated.push({
            key: `rule:${rule.id}:${startsAt.toISOString()}`,
            startsAt,
            endsAt,
            consultationTypes: rule.consultationTypes,
            locationId: rule.locationId,
            source: "rule",
          });
        }
      }
    }
    for (const extra of exceptions.filter((item) => item.kind === "extra")) {
      if (extra.startTime === null || extra.endTime === null) continue;
      const startsAt = dateAtTime(date, extra.startTime);
      generated.push({
        key: `exception:${extra.id}:${startsAt.toISOString()}`,
        startsAt,
        endsAt: endAtTime(date, extra.startTime, extra.endTime),
        consultationTypes: extra.consultationTypes ?? [],
        locationId: extra.locationId,
        source: "exception",
      });
    }
  }

  for (const slot of input.explicitSlots) {
    if (slot.status !== "open") continue;
    generated.push({
      key: `explicit:${slot.id}`,
      startsAt: slot.startsAt,
      endsAt: slot.endsAt,
      consultationTypes: slot.consultationTypes,
      locationId: slot.locationId,
      source: "explicit",
    });
  }

  const unavailable = input.explicitSlots.filter((slot) => slot.status !== "open");
  const candidates = generated
    .filter(
      (slot) => slot.startsAt > input.now && slot.startsAt >= input.from && slot.endsAt <= input.to,
    )
    .filter(
      (slot) =>
        !unavailable.some((item) =>
          intersects(slot.startsAt, slot.endsAt, item.startsAt, item.endsAt),
        ),
    );

  // Explicit extras and date exceptions are more specific than recurring rules.
  // Resolve collisions by precedence, then return the canonical sequence by time.
  const precedence = { explicit: 0, exception: 1, rule: 2 };
  const selected: PublicAvailabilitySlot[] = [];
  for (const candidate of candidates.toSorted(
    (left, right) =>
      precedence[left.source] - precedence[right.source] ||
      left.startsAt.getTime() - right.startsAt.getTime(),
  )) {
    if (
      !selected.some((item) =>
        intersects(candidate.startsAt, candidate.endsAt, item.startsAt, item.endsAt),
      )
    ) {
      selected.push(candidate);
    }
  }
  return selected.toSorted((left, right) => left.startsAt.getTime() - right.startsAt.getTime());
};
