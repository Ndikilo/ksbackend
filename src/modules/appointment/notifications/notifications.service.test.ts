import { it } from "@effect/vitest";
import { Effect, Layer } from "effect";
import { describe, expect } from "vitest";

import {
  cancelScenario,
  lifecycleDedupKey,
  lifecyclePlan,
  lifecycleScenarioId,
  RECEIPT_SCENARIO_ID,
  receiptDedupKey,
  type LifecycleActor,
  type LifecycleScenario,
} from "@/domain/appointment/notifications";
import type { ChannelPreferences } from "@/domain/notification/notification";
import { formatClinicInstant } from "@/infra/email-render";
import { OutboxService } from "@/modules/outbox/outbox.service";
import { LifecycleRepo, type PartyIdentity } from "./notifications.repo";
import { LifecycleNotifier, LifecycleNotifierLive } from "./notifications.service";

/**
 * P6.T3 — the lifecycle ORCHESTRATION against in-memory fakes (the pure
 * transition→notification table has its own domain test; the DB-level dedup
 * race is proven by the outbox's integration tier). Pinned here, Docker-free:
 *
 * - EVERY (scenario, actor) transition enqueues EXACTLY the rows its plan
 *   owes — right recipients, right scenario id, right dedup keys, category,
 *   rendered copy (no template keys, clinic-local time, the RIGHT counterpart
 *   name per copy side);
 * - the stored `appointments` preference gates per RECIPIENT (email off for
 *   one party → only the other learns; off for both → nothing at all);
 * - copy is rendered per RECIPIENT locale (an English patient and a
 *   French-default practitioner get different languages in one transition);
 * - a dedup key the outbox already holds counts as a duplicate, never a
 *   second row;
 * - the receipt email rides its own payment-id key and the `account` category
 *   (turning appointment emails off never hides a receipt).
 *
 * Fake discipline: every test creates ONE `makeFakes()` instance and provides
 * ITS layer, so the recorded enqueues are always the ones asserted on.
 */

/** Fixed instants from the epoch (structure-gate discipline): 2026-03-29. */
const NOW: Date = (() => {
  const at = new Date(0);
  at.setUTCFullYear(2026, 2, 29);
  at.setUTCHours(9, 0, 0, 0);
  return at;
})();
const STARTS_AT: Date = new Date(NOW.getTime() + 26 * 3_600_000);

const PATIENT: PartyIdentity = {
  userId: "user-p",
  email: "patient@example.com",
  locale: null,
  name: "Ada Ngono",
};
const PRACTITIONER: PartyIdentity = {
  userId: "user-d",
  email: "doc@example.com",
  locale: null,
  name: "Dr Ngo Bell",
};

const APPOINTMENT = {
  id: "apt-1",
  patientUserId: PATIENT.userId,
  practitionerProfileId: "prof-1",
  startsAt: STARTS_AT,
};

type RecordedEnqueue = {
  readonly dedupKey: string | undefined;
  readonly scenario: string;
  readonly category: string;
  readonly channel: string;
  readonly locale: string;
  readonly recipient: string;
  readonly title: string;
  readonly bodyText: string;
  readonly bodyHtml: string;
};

/** The fakes one test drives: recorded enqueues + the layer providing them. */
type LifecycleFakes = {
  readonly enqueues: Array<RecordedEnqueue>;
  readonly layer: Layer.Layer<LifecycleNotifier>;
};

/** Scripted repo + recording outbox; `existingKeys` simulates earlier rows. */
const makeFakes = (options?: {
  readonly patient?: PartyIdentity;
  readonly practitioner?: PartyIdentity;
  /** Keyed by category — a missing category means "no rows, code defaults". */
  readonly preferences?: ReadonlyMap<string, ReadonlyMap<string, ChannelPreferences>>;
  readonly existingKeys?: ReadonlySet<string>;
}): LifecycleFakes => {
  const enqueues: Array<RecordedEnqueue> = [];

  const patient = options?.patient ?? PATIENT;
  const practitioner = options?.practitioner ?? PRACTITIONER;

  const LifecycleRepoFake = Layer.succeed(LifecycleRepo, {
    parties: ({ patientUserId }) =>
      Effect.succeed(patient.userId === patientUserId ? { patient, practitioner } : undefined),
    userById: (userId) => Effect.succeed(userId === patient.userId ? patient : undefined),
    preferencesFor: (userIds, category) =>
      Effect.succeed(
        new Map(
          [
            ...(options?.preferences?.get(category) ?? new Map<string, ChannelPreferences>()),
          ].filter(([userId]) => userIds.includes(userId)),
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
          title: input.payload.title,
          bodyText: input.payload.bodyText,
          bodyHtml: input.payload.bodyHtml,
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
    drain: () => Effect.succeed({ claimed: 0, sent: 0, failed: 0, dead: 0 }),
    failures: () => Effect.succeed([]),
  });

  return {
    enqueues,
    layer: LifecycleNotifierLive.pipe(Layer.provide(Layer.mergeAll(LifecycleRepoFake, OutboxFake))),
  };
};

/** The full transition matrix the plan table defines. */
const TRANSITIONS: ReadonlyArray<{
  readonly name: string;
  readonly scenario: LifecycleScenario;
  readonly actor: LifecycleActor;
}> = [
  { name: "booking created", scenario: "booked", actor: "patient" },
  { name: "payment-confirmed", scenario: "confirmed", actor: "practitioner" },
  { name: "rescheduled by patient", scenario: "rescheduled", actor: "patient" },
  { name: "rescheduled by practitioner", scenario: "rescheduled", actor: "practitioner" },
  { name: "cancelled by patient", scenario: "cancelled", actor: "patient" },
  { name: "cancelled by practitioner", scenario: "cancelled", actor: "practitioner" },
  { name: "cancelled by admin (refund)", scenario: "cancelled", actor: "admin" },
  {
    name: "declined (practitioner cancels a pending)",
    scenario: "declined",
    actor: "practitioner",
  },
];

const inputFor = (scenario: LifecycleScenario, actor: LifecycleActor) => ({
  appointment: APPOINTMENT,
  // The decline mapping itself is pinned in the domain test; here the mapped
  // scenario flows through the same public API every caller uses.
  scenario: scenario === "declined" ? cancelScenario("practitioner", "pending") : scenario,
  actor,
  sequence: scenario === "rescheduled" ? NOW.getTime() : undefined,
});

describe.each(TRANSITIONS)("$name → exactly the planned notifications", ({ scenario, actor }) => {
  it.effect("enqueues exactly the planned rows with the right shape", () => {
    const fakes = makeFakes();
    return Effect.gen(function* () {
      const notifier = yield* LifecycleNotifier;
      const plan = lifecyclePlan(scenario, actor);
      const summary = yield* notifier.notify(inputFor(scenario, actor));

      expect(fakes.enqueues).toHaveLength(plan.length);
      expect(summary).toEqual({ enqueued: plan.length, duplicates: 0 });

      // Row-for-row: recipient, copy side, dedup key, category, scenario id.
      // Both sets are paired by EMAIL (a stable common key) before comparing.
      const rows = [...fakes.enqueues].toSorted((a, b) => a.recipient.localeCompare(b.recipient));
      const planned = plan
        .map((entry) => ({
          entry,
          email: entry.recipient === "patient" ? PATIENT.email : PRACTITIONER.email,
        }))
        .toSorted((a, b) => a.email.localeCompare(b.email));
      for (const [index, row] of rows.entries()) {
        const entry = planned[index]?.entry;
        expect(entry).toBeDefined();
        expect(row.recipient).toBe(planned[index]?.email);
        expect(row.channel).toBe("email");
        expect(row.category).toBe("appointments");
        expect(row.scenario).toBe(lifecycleScenarioId[scenario]);
        expect(row.dedupKey).toBe(
          lifecycleDedupKey(
            scenario,
            APPOINTMENT.id,
            entry?.recipient ?? "patient",
            "email",
            scenario === "rescheduled" ? NOW.getTime() : undefined,
          ),
        );
        // No template keys or unreplaced params leak into the payload.
        for (const text of [row.title, row.bodyText, row.bodyHtml]) {
          expect(text).not.toMatch(/emails\.|\{when\}|\{patient\}|\{practitioner\}/);
        }
      }
    }).pipe(Effect.provide(fakes.layer));
  });
});

it.effect(
  "renders per-recipient copy: fr default for both parties, names on the right side",
  () => {
    const fakes = makeFakes();
    return Effect.gen(function* () {
      const notifier = yield* LifecycleNotifier;
      yield* notifier.notify(inputFor("booked", "patient"));

      expect(fakes.enqueues).toHaveLength(2);
      const byRecipient = new Map(fakes.enqueues.map((row) => [row.recipient, row]));
      const patientRow = byRecipient.get(PATIENT.email);
      const practitionerRow = byRecipient.get(PRACTITIONER.email);
      // fr is the app default for unset locales; the Douala clock renders the time.
      expect(patientRow?.locale).toBe("fr");
      expect(patientRow?.title).toBe(
        `Demande de rendez-vous reçue — ${formatClinicInstant("fr", STARTS_AT)}`,
      );
      // Patient-facing copy names the PRACTITIONER; practitioner-facing names the PATIENT.
      expect(patientRow?.bodyText).toContain(PRACTITIONER.name);
      expect(patientRow?.bodyText).not.toContain(PATIENT.name);
      expect(practitionerRow?.bodyText).toContain(PATIENT.name);
      expect(practitionerRow?.bodyText).not.toContain(PRACTITIONER.name);
      // The html body carries the same counterpart name (no cross-wiring).
      expect(patientRow?.bodyHtml).toContain(PRACTITIONER.name);
    }).pipe(Effect.provide(fakes.layer));
  },
);

it.effect("renders each recipient's OWN locale (en patient, fr-default practitioner)", () => {
  const fakes = makeFakes({ patient: { ...PATIENT, locale: "en-GB" } });
  return Effect.gen(function* () {
    const notifier = yield* LifecycleNotifier;
    yield* notifier.notify(inputFor("cancelled", "patient"));

    const byRecipient = new Map(fakes.enqueues.map((row) => [row.recipient, row]));
    expect(byRecipient.get(PATIENT.email)?.locale).toBe("en");
    expect(byRecipient.get(PATIENT.email)?.title).toContain("cancelled");
    expect(byRecipient.get(PRACTITIONER.email)?.locale).toBe("fr");
    expect(byRecipient.get(PRACTITIONER.email)?.title).toContain("annulé par le patient");
  }).pipe(Effect.provide(fakes.layer));
});

it.effect("gates per recipient: email off for one party → only the other learns", () => {
  const fakes = makeFakes({
    preferences: new Map([
      ["appointments", new Map([[PATIENT.userId, { email: false, sms: true, push: true }]])],
    ]),
  });
  return Effect.gen(function* () {
    const notifier = yield* LifecycleNotifier;
    const summary = yield* notifier.notify(inputFor("rescheduled", "patient"));

    expect(summary).toEqual({ enqueued: 1, duplicates: 0 });
    expect(fakes.enqueues.map((row) => row.recipient)).toEqual([PRACTITIONER.email]);
  }).pipe(Effect.provide(fakes.layer));
});

it.effect("gates both parties off → nothing enqueues at all", () => {
  const fakes = makeFakes({
    preferences: new Map([
      [
        "appointments",
        new Map([
          [PATIENT.userId, { email: false, sms: false, push: false }],
          [PRACTITIONER.userId, { email: false, sms: false, push: false }],
        ]),
      ],
    ]),
  });
  return Effect.gen(function* () {
    const notifier = yield* LifecycleNotifier;
    const summary = yield* notifier.notify(inputFor("cancelled", "practitioner"));

    expect(summary).toEqual({ enqueued: 0, duplicates: 0 });
    expect(fakes.enqueues).toHaveLength(0);
  }).pipe(Effect.provide(fakes.layer));
});

it.effect("counts an existing dedup key as a duplicate (no second row)", () => {
  const fakes = makeFakes({
    existingKeys: new Set([lifecycleDedupKey("booked", APPOINTMENT.id, "patient", "email")]),
  });
  return Effect.gen(function* () {
    const notifier = yield* LifecycleNotifier;
    const summary = yield* notifier.notify(inputFor("booked", "patient"));

    expect(summary).toEqual({ enqueued: 1, duplicates: 1 });
    expect(fakes.enqueues.map((row) => row.recipient)).toEqual([PRACTITIONER.email]);
  }).pipe(Effect.provide(fakes.layer));
});

it.effect("reschedule keys carry the transition instant (a move back notifies again)", () =>
  Effect.gen(function* () {
    // Move A (its own fake set — the runtime that records it).
    const first = makeFakes();
    const notifierA = yield* LifecycleNotifier.pipe(Effect.provide(first.layer));
    const summaryA = yield* notifierA.notify(inputFor("rescheduled", "patient"));
    expect(summaryA).toEqual({ enqueued: 2, duplicates: 0 });
    expect(first.enqueues.every((row) => row.dedupKey?.endsWith(`:${NOW.getTime()}`))).toBe(true);

    // Move B against a runtime pre-seeded with move A's keys: the NEW sequence
    // must produce NEW keys (not absorbed as duplicates) — A→B→A notifies twice.
    const second = makeFakes({
      existingKeys: new Set(
        first.enqueues.flatMap((row) => (row.dedupKey !== undefined ? [row.dedupKey] : [])),
      ),
    });
    const notifierB = yield* LifecycleNotifier.pipe(Effect.provide(second.layer));
    const summaryB = yield* notifierB.notify({
      ...inputFor("rescheduled", "patient"),
      sequence: NOW.getTime() + 5_000,
    });
    expect(summaryB).toEqual({ enqueued: 2, duplicates: 0 });
    expect(
      second.enqueues.every((row) => row.dedupKey?.endsWith(`:${NOW.getTime() + 5_000}`)),
    ).toBe(true);
  }),
);

describe("receipt email — rides the confirmed transition's payment", () => {
  const payment = {
    id: "pay-1",
    receiptNumber: "KS-pay-1",
    amountXaf: 5000,
    provider: "momo" as const,
    receiptIssuedAt: NOW,
  };

  it.effect("enqueues one email keyed on the payment id, under the account category", () => {
    const fakes = makeFakes();
    return Effect.gen(function* () {
      const notifier = yield* LifecycleNotifier;
      const summary = yield* notifier.receipt({ patientUserId: PATIENT.userId, payment });

      expect(summary).toEqual({ enqueued: 1, duplicates: 0 });
      expect(fakes.enqueues).toHaveLength(1);
      const row = fakes.enqueues[0];
      expect(row?.dedupKey).toBe(receiptDedupKey(payment.id, "email"));
      expect(row?.scenario).toBe(RECEIPT_SCENARIO_ID);
      expect(row?.category).toBe("account");
      expect(row?.recipient).toBe(PATIENT.email);
      expect(row?.title).toContain(payment.receiptNumber);
      expect(row?.bodyText).toContain("5000 XAF");
      expect(row?.bodyHtml).toContain(payment.receiptNumber);
      expect(row?.bodyHtml).toContain("5000 XAF");
    }).pipe(Effect.provide(fakes.layer));
  });

  it.effect("is gated by the ACCOUNT category, not appointments", () => {
    const fakes = makeFakes({
      preferences: new Map([
        ["appointments", new Map([[PATIENT.userId, { email: false, sms: false, push: false }]])],
      ]),
    });
    return Effect.gen(function* () {
      const notifier = yield* LifecycleNotifier;
      const summary = yield* notifier.receipt({ patientUserId: PATIENT.userId, payment });

      // Appointment emails are off — the receipt (financial record) still goes.
      expect(summary).toEqual({ enqueued: 1, duplicates: 0 });
      expect(fakes.enqueues).toHaveLength(1);
    }).pipe(Effect.provide(fakes.layer));
  });

  it.effect("respects the account category being off (nothing enqueues)", () => {
    const fakes = makeFakes({
      preferences: new Map([
        ["account", new Map([[PATIENT.userId, { email: false, sms: false, push: false }]])],
      ]),
    });
    return Effect.gen(function* () {
      const notifier = yield* LifecycleNotifier;
      const summary = yield* notifier.receipt({ patientUserId: PATIENT.userId, payment });

      expect(summary).toEqual({ enqueued: 0, duplicates: 0 });
      expect(fakes.enqueues).toHaveLength(0);
    }).pipe(Effect.provide(fakes.layer));
  });
});
