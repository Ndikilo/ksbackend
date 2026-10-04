import { it } from "@effect/vitest";
import { Effect, Layer } from "effect";
import { expect } from "vitest";

import type { ChannelPreferences } from "@/domain/notification/notification";
import { formatClinicInstant } from "@/infra/email-render";
import { OutboxService } from "@/modules/outbox/outbox.service";
import type { ReminderCandidateRow } from "@/modules/reminder/reminder.repo";
import { ReminderRepo } from "@/modules/reminder/reminder.repo";
import { ReminderScheduler, ReminderSchedulerLive } from "@/modules/reminder/reminder.service";

/**
 * P6.T2 — the scheduler ORCHESTRATION against in-memory fakes (the pure
 * window table has its own domain test; the DB-level dedup race has the
 * integration tier). Pinned here, Docker-free:
 *
 * - one pass turns due candidates into enqueue calls with the RIGHT shape:
 *   dedup key, scenario, category, recipient, pinned availableAt;
 * - the payload is RENDERED at enqueue time (fr default locale, practitioner
 *   name interpolated, clinic-local Douala time — never a template key);
 * - the stored preference matrix gates the channels (email off → nothing,
 *   even when the row exists);
 * - a dedup key the outbox already holds counts as a duplicate, never a
 *   second enqueue;
 * - cancelled / late-booked candidates are SKIPPED (cancelled before send);
 * - every pass ends with a drain, and its summary flows through.
 */

/**
 * Fixed instants, built from the epoch (the structure gate rightly bans
 * string-parsed dates — they read as non-deterministic wall-clock input).
 * NOW = 2026-03-29T09:00:00Z (08:30 remaining to the appointment).
 */
const NOW: Date = (() => {
  const at = new Date(0);
  at.setUTCFullYear(2026, 2, 29);
  at.setUTCHours(9, 0, 0, 0);
  return at;
})();
// The appointment starts 30 minutes after NOW: both horizons' due points
// (start − 24h / start − 1h) are already past, so one pass must enqueue both.
const STARTS_AT: Date = new Date(NOW.getTime() + 30 * 60_000);

const candidateRow = (overrides?: Partial<ReminderCandidateRow>): ReminderCandidateRow => ({
  id: "apt-1",
  status: "confirmed",
  startsAt: STARTS_AT,
  createdAt: new Date(STARTS_AT.getTime() - 30 * 86_400_000),
  patientUserId: "user-1",
  patientEmail: "patient@example.com",
  patientLocale: null,
  practitionerName: "Dr Ngo Bell",
  ...overrides,
});

/** Scripted repo + recording outbox; `existingKeys` simulates an earlier pass. */
const makeFakes = (options?: {
  readonly candidates?: ReadonlyArray<ReminderCandidateRow>;
  readonly preferences?: ReadonlyMap<string, ChannelPreferences>;
  readonly existingKeys?: ReadonlySet<string>;
}) => {
  const enqueues: Array<{
    readonly dedupKey: string | undefined;
    readonly scenario: string;
    readonly category: string;
    readonly channel: string;
    readonly locale: string;
    readonly recipient: string;
    readonly availableAt: Date;
    readonly title: string;
    readonly bodyText: string;
  }> = [];
  let drained = 0;

  const ReminderRepoFake = Layer.succeed(ReminderRepo, {
    findDueCandidates: ({ now, windowMs }) =>
      Effect.succeed(
        (options?.candidates ?? []).filter(
          (c) =>
            c.startsAt.getTime() > now.getTime() &&
            c.startsAt.getTime() <= now.getTime() + windowMs,
        ),
      ),
    preferencesFor: (userIds) =>
      Effect.succeed(
        new Map(
          [...(options?.preferences ?? new Map())].filter(([userId]) => userIds.includes(userId)),
        ),
      ),
  });

  const OutboxFake = Layer.succeed(OutboxService, {
    enqueue: (input) =>
      Effect.sync(() => {
        if (input.dedupKey !== undefined && options?.existingKeys?.has(input.dedupKey)) {
          return undefined;
        }
        const at = input.availableAt ?? NOW;
        enqueues.push({
          dedupKey: input.dedupKey,
          scenario: input.scenario,
          category: input.category,
          channel: input.channel,
          locale: input.locale,
          recipient: input.recipient,
          availableAt: at,
          title: input.payload.title,
          bodyText: input.payload.bodyText,
        });
        return {
          id: `row-${enqueues.length}`,
          userId: input.userId,
          channel: input.channel,
          category: input.category,
          scenario: input.scenario,
          locale: input.locale,
          recipient: input.recipient,
          payload: input.payload,
          status: "pending",
          attempts: 0,
          lastError: null,
          providerMessageId: null,
          availableAt: at,
          sentAt: null,
          createdAt: at,
          updatedAt: at,
        };
      }),
    drain: ({ limit }) =>
      Effect.sync(() => {
        drained += 1;
        expect(limit).toBeGreaterThan(0);
        return { claimed: 0, sent: 0, failed: 0, dead: 0 };
      }),
    failures: () => Effect.succeed([]),
  });

  const layer = ReminderSchedulerLive.pipe(
    Layer.provide(Layer.mergeAll(ReminderRepoFake, OutboxFake)),
  );

  return {
    enqueues,
    drainedCount: () => drained,
    layer,
  };
};

it.effect("enqueues both horizons for a due candidate with the exact outbox shape", () =>
  Effect.gen(function* () {
    const fakes = makeFakes({ candidates: [candidateRow()] });
    const summary = yield* Effect.flatMap(ReminderScheduler, (service) =>
      service.run({ now: NOW }),
    ).pipe(Effect.provide(fakes.layer));

    expect(summary.scanned).toBe(1);
    expect(summary.enqueued).toBe(2);
    expect(summary.duplicates).toBe(0);
    expect(summary.skipped).toBe(0);
    expect(fakes.drainedCount()).toBe(1);

    expect(fakes.enqueues.map((e) => e.dedupKey)).toEqual([
      "reminder-24h:apt-1:email",
      "reminder-1h:apt-1:email",
    ]);
    expect(fakes.enqueues.map((e) => e.scenario)).toEqual(["reminder-24h", "reminder-1h"]);
    for (const enqueue of fakes.enqueues) {
      expect(enqueue.category).toBe("appointments");
      expect(enqueue.channel).toBe("email");
      expect(enqueue.recipient).toBe("patient@example.com");
      // The reminder is due NOW, not scheduled for later — the drain delivers
      // it on this very pass.
      expect(enqueue.availableAt.getTime()).toBe(NOW.getTime());
    }
  }),
);

it.effect("renders the payload at enqueue time: fr default, practitioner, Douala time", () =>
  Effect.gen(function* () {
    const fakes = makeFakes({ candidates: [candidateRow()] });
    yield* Effect.flatMap(ReminderScheduler, (service) => service.run({ now: NOW })).pipe(
      Effect.provide(fakes.layer),
    );

    // user.locale is null → the app default fr.
    expect(fakes.enqueues[0]?.locale).toBe("fr");
    // The title carries the CLINIC-clock rendering (formatClinicInstant is
    // pinned to Africa/Douala in email-render.test — never the server's zone).
    expect(fakes.enqueues[0]?.title).toBe(
      `Rappel — rendez-vous le ${formatClinicInstant("fr", STARTS_AT)}`,
    );
    expect(fakes.enqueues[0]?.bodyText).toContain("Dr Ngo Bell");
    // A template key leaking through means a missing translation — banned.
    for (const enqueue of fakes.enqueues) {
      expect(enqueue.title).not.toMatch(/emails\.|\{when\}|\{practitioner\}/);
      expect(enqueue.bodyText).not.toMatch(/emails\.|\{when\}|\{practitioner\}/);
    }
  }),
);

it.effect("honours the stored preference matrix (email off ⇒ nothing enqueues)", () =>
  Effect.gen(function* () {
    const fakes = makeFakes({
      candidates: [candidateRow()],
      preferences: new Map([["user-1", { email: false, sms: true, push: false }]]),
    });
    const summary = yield* Effect.flatMap(ReminderScheduler, (service) =>
      service.run({ now: NOW }),
    ).pipe(Effect.provide(fakes.layer));

    expect(fakes.enqueues).toHaveLength(0);
    expect(summary.enqueued).toBe(0);
    // The drain still runs — other users' enqueued rows must flow.
    expect(fakes.drainedCount()).toBe(1);
  }),
);

it.effect("counts a dedup key the outbox already holds as a duplicate (no second row)", () =>
  Effect.gen(function* () {
    const fakes = makeFakes({
      candidates: [candidateRow()],
      existingKeys: new Set(["reminder-24h:apt-1:email"]),
    });
    const summary = yield* Effect.flatMap(ReminderScheduler, (service) =>
      service.run({ now: NOW }),
    ).pipe(Effect.provide(fakes.layer));

    expect(summary.enqueued).toBe(1); // only the 1h horizon is new
    expect(summary.duplicates).toBe(1);
    expect(fakes.enqueues.map((e) => e.dedupKey)).toEqual(["reminder-1h:apt-1:email"]);
  }),
);

it.effect("skips cancelled appointments (cancelled before send) and late bookings", () =>
  Effect.gen(function* () {
    const fakes = makeFakes({
      candidates: [
        candidateRow({ id: "apt-cancelled", status: "cancelled" }),
        candidateRow({
          id: "apt-late",
          // Booked 90 minutes ahead: inside the 24h window, outside the 1h.
          createdAt: new Date(STARTS_AT.getTime() - 90 * 60_000),
        }),
      ],
    });
    const summary = yield* Effect.flatMap(ReminderScheduler, (service) =>
      service.run({ now: NOW }),
    ).pipe(Effect.provide(fakes.layer));

    // cancelled: both horizons skip; late: 24h skips, 1h enqueues.
    expect(summary.skipped).toBe(3);
    expect(summary.enqueued).toBe(1);
    expect(fakes.enqueues.map((e) => e.dedupKey)).toEqual(["reminder-1h:apt-late:email"]);
  }),
);

it.effect("does nothing (but still drains) when no candidate is in the window", () =>
  Effect.gen(function* () {
    const fakes = makeFakes({ candidates: [] });
    const summary = yield* Effect.flatMap(ReminderScheduler, (service) =>
      service.run({ now: NOW }),
    ).pipe(Effect.provide(fakes.layer));

    expect(summary.scanned).toBe(0);
    expect(fakes.enqueues).toHaveLength(0);
    expect(fakes.drainedCount()).toBe(1);
  }),
);
