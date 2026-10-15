import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { user } from "@/db/schema/auth";
import { appointment as appointmentTable } from "@/db/schema/appointment";
import { availabilitySlot } from "@/db/schema/availability-slot";
import { consultationOffering } from "@/db/schema/consultation-offering";
import { profession } from "@/db/schema/profession";
import { createTestHarness, type TestHarness } from "../support/app-harness";

// SAFETY: API tests call endpoints with known response contracts and immediately assert on those shapes.
const json = <T>(res: Response): Promise<T> => res.json() as Promise<T>;

/**
 * P3.T4 — the booking authorization matrix against a real Postgres
 * (Docker/CI tier). Pins WHO can act on WHAT:
 *
 *   - anonymous callers get 401 everywhere;
 *   - a patient reaches only their own (and their dependents') bookings —
 *     another patient with the SAME practitioner still gets the 404 of an
 *     unknown id (no existence leak);
 *   - a practitioner acts only on their own calendar — even while legitimately
 *     acting on their own appointments, another doctor's appointment is 404;
 *   - dependents are bookable only by their linked (active) caregiver;
 *   - admins hold no appointment superpowers — admin scope lives in the admin
 *     routes only; as appointment callers they are plain users.
 */
describe("appointments authorization (real DB)", () => {
  let harness: TestHarness;
  let patientACookie: string;
  let patientBCookie: string;
  let doctorACookie: string;
  let doctorBCookie: string;
  let adminCookie: string;
  let doctorAProfileId: string;
  let doctorBProfileId: string;
  let offeringAId: string;
  let offeringBId: string;
  let dependentAId: string;
  let patientAId: string;

  /** A future 60-minute in_person slot owned by `profileId`. */
  const seedSlot = async (profileId: string, minutesAhead: number): Promise<string> => {
    const slotId = crypto.randomUUID();
    const startsAt = new Date(Date.now() + minutesAhead * 60_000);
    await harness.db.insert(availabilitySlot).values({
      id: slotId,
      practitionerProfileId: profileId,
      startsAt,
      endsAt: new Date(startsAt.getTime() + 60 * 60_000),
      consultationTypes: ["in_person"],
    });
    return slotId;
  };

  const book = (
    cookie: string,
    body: { slotId: string; offeringId: string; dependentId?: string },
  ) => harness.post("/v1/appointments", body, cookie);

  const getAppointments = async () => {
    const rows = await harness.db
      .select({
        id: appointmentTable.id,
        slotId: appointmentTable.slotId,
        status: appointmentTable.status,
      })
      .from(appointmentTable);
    return new Map(rows.map((row) => [row.id, row]));
  };

  beforeAll(async () => {
    harness = await createTestHarness();
    patientACookie = await harness.signUpAndVerify(
      "authz-a@example.com",
      "password12345",
      "A Alpha",
    );
    patientBCookie = await harness.signUpAndVerify(
      "authz-b@example.com",
      "password12345",
      "B Bravo",
    );
    doctorACookie = await harness.signUpAndVerify(
      "authz-doc-a@example.com",
      "password12345",
      "Doc A",
    );
    doctorBCookie = await harness.signUpAndVerify(
      "authz-doc-b@example.com",
      "password12345",
      "Doc B",
    );
    adminCookie = await harness.signUpAndVerify(
      "authz-admin@example.com",
      "password12345",
      "Ad Min",
    );
    await harness.promoteToAdmin("authz-admin@example.com");

    patientAId = await harness.userIdFor("authz-a@example.com");
    await harness.db
      .update(user)
      .set({ role: "doctor" })
      .where(eq(user.email, "authz-doc-a@example.com"));
    await harness.db
      .update(user)
      .set({ role: "doctor" })
      .where(eq(user.email, "authz-doc-b@example.com"));

    const professionId = crypto.randomUUID();
    await harness.db
      .insert(profession)
      .values({ id: professionId, nameEn: "Doctor", nameFr: "Médecin" });
    doctorAProfileId = crypto.randomUUID();
    doctorBProfileId = crypto.randomUUID();
    await harness.seedPractitionerProfile({
      id: doctorAProfileId,
      userId: await harness.userIdFor("authz-doc-a@example.com"),
      professionId,
    });
    await harness.seedPractitionerProfile({
      id: doctorBProfileId,
      userId: await harness.userIdFor("authz-doc-b@example.com"),
      professionId,
    });
    offeringAId = crypto.randomUUID();
    offeringBId = crypto.randomUUID();
    await harness.db.insert(consultationOffering).values([
      {
        id: offeringAId,
        practitionerProfileId: doctorAProfileId,
        consultationType: "in_person",
        durationMin: 60,
        priceXaf: 5000,
      },
      {
        id: offeringBId,
        practitionerProfileId: doctorBProfileId,
        consultationType: "in_person",
        durationMin: 60,
        priceXaf: 4000,
      },
    ]);

    const created = await harness.post(
      "/v1/dependents",
      {
        surname: "Alpha",
        givenNames: "Kid",
        dateOfBirth: "2016-05-05",
        sex: "male",
        relationship: "child",
      },
      patientACookie,
    );
    expect(created.status).toBe(201);
    dependentAId = (await json<{ id: string }>(created)).id;
  }, 120_000);

  afterAll(() => harness.dispose());

  it("anonymous callers get 401 on every appointment endpoint", async () => {
    const id = crypto.randomUUID();
    const [created, listed, got, rescheduled, cancelled] = await Promise.all([
      harness.post("/v1/appointments", { slotId: id, offeringId: id }),
      harness.app.request("/v1/appointments"),
      harness.app.request(`/v1/appointments/${id}`),
      harness.app.request(`/v1/appointments/${id}/reschedule`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ slotId: id }),
      }),
      harness.app.request(`/v1/appointments/${id}/cancel`, { method: "POST" }),
    ]);
    expect([created, listed, got, rescheduled, cancelled].map((r) => r.status)).toEqual([
      401, 401, 401, 401, 401,
    ]);
  });

  it("a patient cannot read or mutate another patient's appointment — same practitioner does not help", async () => {
    const slotA = await seedSlot(doctorAProfileId, 40 * 24 * 60);
    const ofA = await book(patientACookie, { slotId: slotA, offeringId: offeringAId });
    expect(ofA.status).toBe(201);
    const appointmentA = await json<{ id: string }>(ofA);

    // B books their own appointment with the SAME practitioner, so the 404s
    // below cannot be explained by an unknown practitioner.
    const slotB = await seedSlot(doctorAProfileId, 41 * 24 * 60);
    expect((await book(patientBCookie, { slotId: slotB, offeringId: offeringAId })).status).toBe(
      201,
    );

    const [got, rescheduled, cancelled] = [
      await harness.app.request(`/v1/appointments/${appointmentA.id}`, {
        headers: { cookie: patientBCookie },
      }),
      await harness.app.request(`/v1/appointments/${appointmentA.id}/reschedule`, {
        method: "POST",
        headers: { "content-type": "application/json", cookie: patientBCookie },
        body: JSON.stringify({ slotId: await seedSlot(doctorAProfileId, 42 * 24 * 60) }),
      }),
      await harness.app.request(`/v1/appointments/${appointmentA.id}/cancel`, {
        method: "POST",
        headers: { cookie: patientBCookie },
      }),
    ];
    const attempts = [got, rescheduled, cancelled];
    for (const res of attempts) expect(res.status).toBe(404);
    const bodies = await Promise.all(attempts.map((res) => json<{ error: { code: string } }>(res)));
    for (const body of bodies) expect(body.error.code).toBe("NOT_FOUND");
    // A forged id is indistinguishable from someone else's id (no existence leak).
    const unknown = await harness.app.request(`/v1/appointments/${crypto.randomUUID()}`, {
      headers: { cookie: patientBCookie },
    });
    expect(unknown.status).toBe(404);
    expect((await json<{ error: { code: string } }>(unknown)).error.code).toBe("NOT_FOUND");

    // None of B's attempts changed A's booking.
    const rows = await getAppointments();
    expect(rows.get(appointmentA.id)?.status).toBe("pending");
    expect(
      (
        await harness.app.request(`/v1/appointments/${appointmentA.id}`, {
          headers: { cookie: patientACookie },
        })
      ).status,
    ).toBe(200);
  });

  it("a practitioner acts only on their own calendar — even one where they have appointments", async () => {
    // B's own booking with doctor B: doctor B legitimately acts on THIS one.
    const ownSlot = await seedSlot(doctorBProfileId, 43 * 24 * 60);
    const own = await book(patientBCookie, { slotId: ownSlot, offeringId: offeringBId });
    expect(own.status).toBe(201);
    const ownAppointment = await json<{ id: string }>(own);

    // A's booking with doctor A: doctor B is NOT a party to it.
    const foreignSlot = await seedSlot(doctorAProfileId, 44 * 24 * 60);
    const foreign = await book(patientACookie, { slotId: foreignSlot, offeringId: offeringAId });
    const foreignAppointment = await json<{ id: string }>(foreign);

    const [got, rescheduled, cancelled] = [
      await harness.app.request(`/v1/appointments/${foreignAppointment.id}`, {
        headers: { cookie: doctorBCookie },
      }),
      await harness.app.request(`/v1/appointments/${foreignAppointment.id}/reschedule`, {
        method: "POST",
        headers: { "content-type": "application/json", cookie: doctorBCookie },
        body: JSON.stringify({ slotId: await seedSlot(doctorBProfileId, 45 * 24 * 60) }),
      }),
      await harness.app.request(`/v1/appointments/${foreignAppointment.id}/cancel`, {
        method: "POST",
        headers: { cookie: doctorBCookie },
      }),
    ];
    for (const res of [got, rescheduled, cancelled]) {
      expect(res.status).toBe(404);
    }

    // The doctor's agenda contains ONLY their own appointments.
    const agenda = await harness.app.request("/v1/appointments?scope=practitioner&limit=100", {
      headers: { cookie: doctorBCookie },
    });
    const page = await json<{ data: ReadonlyArray<{ id: string; practitionerProfileId: string }> }>(
      agenda,
    );
    expect(page.data.map((row) => row.id)).toEqual([ownAppointment.id]);
    for (const row of page.data) expect(row.practitionerProfileId).toBe(doctorBProfileId);

    // The foreign booking is untouched by doctor B's attempts...
    const rows = await getAppointments();
    expect(rows.get(foreignAppointment.id)?.status).toBe("pending");
    // ...and it DOES belong to doctor A's calendar (the positive side of the matrix).
    expect(
      (
        await harness.app.request(`/v1/appointments/${foreignAppointment.id}`, {
          headers: { cookie: doctorACookie },
        })
      ).status,
    ).toBe(200);
  });

  it("a dependent is bookable and visible only to their linked caregiver", async () => {
    const slot = await seedSlot(doctorAProfileId, 46 * 24 * 60);
    const byA = await book(patientACookie, {
      slotId: slot,
      offeringId: offeringAId,
      dependentId: dependentAId,
    });
    expect(byA.status).toBe(201);
    const booking = await json<{ id: string; dependentId: string | null }>(byA);
    expect(booking.dependentId).toBe(dependentAId);

    // B cannot book for A's dependent...
    const othersSlot = await seedSlot(doctorAProfileId, 47 * 24 * 60);
    const notLinked = await book(patientBCookie, {
      slotId: othersSlot,
      offeringId: offeringAId,
      dependentId: dependentAId,
    });
    expect(notLinked.status).toBe(403);
    expect((await json<{ error: { code: string } }>(notLinked)).error.code).toBe("FORBIDDEN");

    // ...cannot see the booking...
    const listed = await harness.app.request("/v1/appointments?limit=100", {
      headers: { cookie: patientBCookie },
    });
    const page = await json<{ data: ReadonlyArray<{ id: string }> }>(listed);
    expect(page.data.some((row) => row.id === booking.id)).toBe(false);

    // ...and B cannot cancel it either (404, not 403 — no existence leak).
    expect(
      (
        await harness.app.request(`/v1/appointments/${booking.id}/cancel`, {
          method: "POST",
          headers: { cookie: patientBCookie },
        })
      ).status,
    ).toBe(404);

    // A (the linked caregiver) sees and manages it normally.
    expect(
      (
        await harness.app.request(`/v1/appointments/${booking.id}`, {
          headers: { cookie: patientACookie },
        })
      ).status,
    ).toBe(200);
  });

  it("admins hold no appointment superpowers — they act as plain users", async () => {
    const slot = await seedSlot(doctorAProfileId, 48 * 24 * 60);
    const ofA = await book(patientACookie, { slotId: slot, offeringId: offeringAId });
    const appointmentA = await json<{ id: string }>(ofA);

    // Admin scope does not cross the party check.
    const [got, cancelled, listedAsPractitioner] = [
      await harness.app.request(`/v1/appointments/${appointmentA.id}`, {
        headers: { cookie: adminCookie },
      }),
      await harness.app.request(`/v1/appointments/${appointmentA.id}/cancel`, {
        method: "POST",
        headers: { cookie: adminCookie },
      }),
      await harness.app.request("/v1/appointments?scope=practitioner", {
        headers: { cookie: adminCookie },
      }),
    ];
    expect(got.status).toBe(404);
    expect(cancelled.status).toBe(404);
    // Not a practitioner either — the agenda stays closed (403).
    expect(listedAsPractitioner.status).toBe(403);

    // As a plain user the admin books for themself and sees only that.
    const ownSlot = await seedSlot(doctorAProfileId, 49 * 24 * 60);
    const own = await book(adminCookie, { slotId: ownSlot, offeringId: offeringAId });
    expect(own.status).toBe(201);
    const listed = await harness.app.request("/v1/appointments?limit=100", {
      headers: { cookie: adminCookie },
    });
    const page = await json<{ data: ReadonlyArray<{ id: string; patientUserId: string }> }>(listed);
    expect(page.data.map((row) => row.id)).toEqual([(await json<{ id: string }>(own)).id]);
    for (const row of page.data) expect(row.patientUserId).not.toBe(patientAId);
  });
});
