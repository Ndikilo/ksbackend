import { describe, expect, it } from "vitest";

import {
  LIFECYCLE_VARIANTS,
  RECEIPT_SCENARIO_ID,
  cancelScenario,
  lifecycleDedupKey,
  lifecycleNameParam,
  lifecyclePlan,
  lifecycleScenarioId,
  receiptDedupKey,
  type LifecycleScenario,
  type LifecycleVariant,
} from "./notifications";

/**
 * P6.T3 — the PURE transition→notification table. This is the "exactly the
 * right notifications" contract: every transition maps to a FIXED recipient +
 * copy-variant set, and any product change to who-learns-what must edit this
 * table (and its assertions) together. The orchestration test then pins that
 * the service enqueues exactly these rows.
 */

describe("lifecyclePlan — each transition owes exactly these notifications", () => {
  it("booking created → confirmation to patient AND practitioner", () => {
    expect(lifecyclePlan("booked", "patient")).toEqual([
      { recipient: "patient", variant: "booked-patient" },
      { recipient: "practitioner", variant: "booked-practitioner" },
    ]);
  });

  it("confirmed → patient only (the receipt email rides alongside)", () => {
    expect(lifecyclePlan("confirmed", "practitioner")).toEqual([
      { recipient: "patient", variant: "confirmed-patient" },
    ]);
  });

  it("rescheduled → both parties, the new time", () => {
    expect(lifecyclePlan("rescheduled", "patient")).toEqual([
      { recipient: "patient", variant: "rescheduled-patient" },
      { recipient: "practitioner", variant: "rescheduled-practitioner" },
    ]);
  });

  it("cancelled by patient → both parties, who-cancelled copy", () => {
    expect(lifecyclePlan("cancelled", "patient")).toEqual([
      { recipient: "patient", variant: "cancelled-self" },
      { recipient: "practitioner", variant: "cancelled-by-patient" },
    ]);
  });

  it("cancelled by practitioner → both parties, mirrored copy", () => {
    expect(lifecyclePlan("cancelled", "practitioner")).toEqual([
      { recipient: "patient", variant: "cancelled-by-practitioner" },
      { recipient: "practitioner", variant: "cancelled-self-practitioner" },
    ]);
  });

  it("cancelled by admin (refund) → both parties, clinic copy", () => {
    expect(lifecyclePlan("cancelled", "admin")).toEqual([
      { recipient: "patient", variant: "cancelled-by-clinic" },
      { recipient: "practitioner", variant: "cancelled-by-clinic-practitioner" },
    ]);
  });

  it("declined (practitioner cancels a PENDING request) → patient only", () => {
    expect(lifecyclePlan("declined", "practitioner")).toEqual([
      { recipient: "patient", variant: "declined" },
    ]);
  });

  it("every variant in the plan has a scenario id and no duplicates", () => {
    // SAFETY: lifecycleScenarioId is `satisfies Record<LifecycleScenario, string>`
    // — its keys are exactly the scenario union, so this cast cannot widen.
    for (const scenario of Object.keys(lifecycleScenarioId) as LifecycleScenario[]) {
      for (const actor of ["patient", "practitioner", "admin"] as const) {
        const entries = lifecyclePlan(scenario, actor);
        const keys = new Set(entries.map((entry) => `${entry.recipient}:${entry.variant}`));
        expect(keys.size).toBe(entries.length);
      }
    }
  });
});

describe("cancelScenario — decline vs cancel is (actor, prior status)", () => {
  it("practitioner + pending = declined", () => {
    expect(cancelScenario("practitioner", "pending")).toBe("declined");
  });
  it("practitioner + confirmed = cancelled", () => {
    expect(cancelScenario("practitioner", "confirmed")).toBe("cancelled");
  });
  it("patient cancel is a cancellation from either status", () => {
    expect(cancelScenario("patient", "pending")).toBe("cancelled");
    expect(cancelScenario("patient", "confirmed")).toBe("cancelled");
  });
  it("admin (refund) cancel is always a cancellation", () => {
    expect(cancelScenario("admin", "pending")).toBe("cancelled");
    expect(cancelScenario("admin", "confirmed")).toBe("cancelled");
  });
});

describe("lifecycleDedupKey — one key per ROW, repeatable transitions sequenced", () => {
  it("distinguishes recipient and channel (the UNIQUE index is global)", () => {
    const patientEmail = lifecycleDedupKey("booked", "apt-1", "patient", "email");
    const practitionerEmail = lifecycleDedupKey("booked", "apt-1", "practitioner", "email");
    const patientPush = lifecycleDedupKey("booked", "apt-1", "patient", "push");
    expect(new Set([patientEmail, practitionerEmail, patientPush]).size).toBe(3);
    expect(patientEmail).toBe("appointment-booked:apt-1:patient:email");
  });

  it("reschedule keys carry the transition instant so A→B→A notifies twice", () => {
    const first = lifecycleDedupKey("rescheduled", "apt-1", "patient", "email", 1000);
    const back = lifecycleDedupKey("rescheduled", "apt-1", "patient", "email", 2000);
    expect(first).toBe("appointment-rescheduled:apt-1:patient:email:1000");
    expect(back).not.toBe(first);
  });

  it("terminal transitions are sequence-free and stable across retries", () => {
    expect(lifecycleDedupKey("cancelled", "apt-1", "patient", "email")).toBe(
      lifecycleDedupKey("cancelled", "apt-1", "patient", "email"),
    );
  });

  it("different scenarios never collide on the same appointment", () => {
    const keys = (["booked", "confirmed", "cancelled", "declined"] as const).map((scenario) =>
      lifecycleDedupKey(scenario, "apt-1", "patient", "email"),
    );
    expect(new Set(keys).size).toBe(keys.length);
  });
});

describe("lifecycleNameParam — one table decides whose name each copy interpolates", () => {
  it("practitioner-facing copy names the patient (every such variant, pinned)", () => {
    const practitionerCopy: ReadonlyArray<LifecycleVariant> = [
      "booked-practitioner",
      "rescheduled-practitioner",
      "cancelled-by-patient",
      "cancelled-self-practitioner",
      "cancelled-by-clinic-practitioner",
    ];
    for (const variant of practitionerCopy) {
      expect(lifecycleNameParam(variant)).toBe("patient");
    }
  });

  it("patient-facing copy names the practitioner (the remaining variants)", () => {
    for (const variant of LIFECYCLE_VARIANTS) {
      if (
        [
          "booked-practitioner",
          "rescheduled-practitioner",
          "cancelled-by-patient",
          "cancelled-self-practitioner",
          "cancelled-by-clinic-practitioner",
        ].includes(variant)
      ) {
        continue;
      }
      expect(lifecycleNameParam(variant)).toBe("practitioner");
    }
  });

  it("every variant the plans reference is covered (no unnamed copy)", () => {
    const used = new Set<LifecycleVariant>();
    // SAFETY: lifecycleScenarioId is `satisfies Record<LifecycleScenario, string>`
    // — its keys are exactly the scenario union, so this cast cannot widen.
    for (const scenario of Object.keys(lifecycleScenarioId) as LifecycleScenario[]) {
      for (const actor of ["patient", "practitioner", "admin"] as const) {
        for (const entry of lifecyclePlan(scenario, actor)) used.add(entry.variant);
      }
    }
    for (const variant of used) {
      expect(["practitioner", "patient"]).toContain(lifecycleNameParam(variant));
    }
  });
});

describe("receiptDedupKey — once per payment, channel-scoped", () => {
  it("keys on the payment id and the channel, under the receipt scenario id", () => {
    expect(receiptDedupKey("pay-1", "email")).toBe("payment-receipt:pay-1:email");
    expect(receiptDedupKey("pay-1", "email")).not.toBe(receiptDedupKey("pay-2", "email"));
    expect(receiptDedupKey("pay-1", "email")).not.toBe(receiptDedupKey("pay-1", "push"));
  });

  it("never collides with a lifecycle key on the same id", () => {
    expect(receiptDedupKey("apt-1", "email")).not.toBe(
      lifecycleDedupKey("confirmed", "apt-1", "patient", "email"),
    );
    expect(RECEIPT_SCENARIO_ID).toBe("payment-receipt");
  });
});
