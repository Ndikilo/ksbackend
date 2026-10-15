import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { user } from "@/db/schema/auth";
import { appointment as appointmentTable } from "@/db/schema/appointment";
import { availabilitySlot } from "@/db/schema/availability-slot";
import { consultationOffering } from "@/db/schema/consultation-offering";
import { notificationOutbox } from "@/db/schema/notification-outbox";
import { profession } from "@/db/schema/profession";
import { createTestHarness, testPassword, type TestHarness } from "../support/app-harness";

// SAFETY: API tests call endpoints with known response contracts and immediately assert on those shapes.
const json = <T>(res: Response): Promise<T> => res.json() as Promise<T>;

/**
 * P7.T3 — the practitioner-driven confirm (`POST /v1/appointments/{id}/confirm`)
 * against a real Postgres (Docker/CI tier). Pins the contract the mobile app
 * already calls:
 *
 *   - authorization: ONLY the appointment's own practitioner may confirm —
 *     the booking patient, another patient, another practitioner and an admin
 *     all get the 404 of an unknown id (the P3.T4 matrix: no existence leak,
 *     no superpowers);
 *   - state machine: `pending` is the only confirmable status (second confirm,
 *     cancelled, completed, no_show → `409 APPOINTMENT_STATE_INVALID`); a slot
 *     that already started → `409 APPOINTMENT_STARTED`;
 *   - response: the updated appointment, byte-for-byte the GET-single shape;
 *   - notifications: the `confirmed` lifecycle scenario joins the P6 outbox in
 *     the SAME transaction — the patient is notified, the practitioner (who
 *     drove it) gets no self-notification.
 */
describe("POST /v1/appointments/{id}/confirm (real DB)", () => {
  let harness: TestHarness;
  let patientCookie: string;
  let otherPatientCookie: string;
  let doctorACookie: string;
  let doctorBCookie: string;
  let adminCookie: string;
  let doctorAProfileId: string;
  let doctorBProfileId: string;
  let offeringAId: string;
  let patientUserId: string;
  let doctorAUserId: string;

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

  const book = async (slotId: string): Promise<string> => {
    const res = await harness.post(
      "/v1/appointments",
      { slotId, offeringId: offeringAId },
      patientCookie,
    );
    expect(res.status).toBe(201);
    return (await json<{ id: string }>(res)).id;
  };

  const confirm = (id: string, cookie?: string) =>
    harness.app.request(`/v1/appointments/${id}/confirm`, {
      method: "POST",
      headers: cookie === undefined ? {} : { cookie },
    });

  /** Direct-seed an appointment in an arbitrary status (future slot by default). */
  const seedAppointment = async (
    status: "pending" | "completed" | "no_show",
    minutesAhead: number,
  ): Promise<string> => {
    const slotId = await seedSlot(doctorAProfileId, minutesAhead);
    const id = crypto.randomUUID();
    const startsAt = new Date(Date.now() + minutesAhead * 60_000);
    await harness.db.insert(appointmentTable).values({
      id,
      patientUserId,
      practitionerProfileId: doctorAProfileId,
      slotId,
      consultationOfferingId: offeringAId,
      consultationType: "in_person",
      startsAt,
      endsAt: new Date(startsAt.getTime() + 60 * 60_000),
      priceXaf: 5000,
      cancellationNoticeHours: 24,
      status,
    });
    return id;
  };

  const outboxRowsFor = async (userId: string) =>
    harness.db
      .select({
        scenario: notificationOutbox.scenario,
        dedupKey: notificationOutbox.dedupKey,
      })
      .from(notificationOutbox)
      .where(eq(notificationOutbox.userId, userId));

  beforeAll(async () => {
    harness = await createTestHarness();
    patientCookie = await harness.signUpAndVerify(
      "confirm-patient@example.com",
      testPassword("patient"),
      "Pa Tient",
    );
    otherPatientCookie = await harness.signUpAndVerify(
      "confirm-other@example.com",
      testPassword("other"),
      "Oth Er",
    );
    doctorACookie = await harness.signUpAndVerify(
      "confirm-doc-a@example.com",
      testPassword("doctor-a"),
      "Doc One",
    );
    doctorBCookie = await harness.signUpAndVerify(
      "confirm-doc-b@example.com",
      testPassword("doctor-b"),
      "Doc Two",
    );
    adminCookie = await harness.signUpAndVerify(
      "confirm-admin@example.com",
      testPassword("admin"),
      "Ad Min",
    );
    await harness.promoteToAdmin("confirm-admin@example.com");

    patientUserId = await harness.userIdFor("confirm-patient@example.com");
    doctorAUserId = await harness.userIdFor("confirm-doc-a@example.com");
    await harness.db
      .update(user)
      .set({ role: "doctor" })
      .where(eq(user.email, "confirm-doc-a@example.com"));
    await harness.db
      .update(user)
      .set({ role: "doctor" })
      .where(eq(user.email, "confirm-doc-b@example.com"));

    const professionId = crypto.randomUUID();
    await harness.db
      .insert(profession)
      .values({ id: professionId, nameEn: "Doctor", nameFr: "Médecin" });
    doctorAProfileId = crypto.randomUUID();
    doctorBProfileId = crypto.randomUUID();
    await harness.seedPractitionerProfile({
      id: doctorAProfileId,
      userId: doctorAUserId,
      professionId,
    });
    await harness.seedPractitionerProfile({
      id: doctorBProfileId,
      userId: await harness.userIdFor("confirm-doc-b@example.com"),
      professionId,
    });
    offeringAId = crypto.randomUUID();
    await harness.db.insert(consultationOffering).values({
      id: offeringAId,
      practitionerProfileId: doctorAProfileId,
      consultationType: "in_person",
      durationMin: 60,
      priceXaf: 5000,
    });
  }, 120_000);

  afterAll(() => harness.dispose());

  it("requires a session", async () => {
    expect((await confirm(crypto.randomUUID())).status).toBe(401);
  });

  it("only the appointment's practitioner may confirm — everyone else gets the anonymous 404 (no existence leak)", async () => {
    const id = await book(await seedSlot(doctorAProfileId, 50 * 24 * 60));

    // The booking patient themself: confirm is the practitioner's acceptance —
    // the patient holds no such power (404, not 403 — house semantics).
    const byPatient = await confirm(id, patientCookie);
    expect(byPatient.status).toBe(404);
    expect((await json<{ error: { code: string } }>(byPatient)).error.code).toBe("NOT_FOUND");

    // A stranger patient with the SAME practitioner: identical 404.
    const byStranger = await confirm(id, otherPatientCookie);
    expect(byStranger.status).toBe(404);
    expect((await json<{ error: { code: string } }>(byStranger)).error.code).toBe("NOT_FOUND");

    // Another practitioner: identical 404.
    const byOtherDoctor = await confirm(id, doctorBCookie);
    expect(byOtherDoctor.status).toBe(404);

    // An admin: no appointment superpowers (404).
    const byAdmin = await confirm(id, adminCookie);
    expect(byAdmin.status).toBe(404);

    // A forged id is indistinguishable from someone else's id.
    const unknown = await confirm(crypto.randomUUID(), doctorACookie);
    expect(unknown.status).toBe(404);
    expect((await json<{ error: { code: string } }>(unknown)).error.code).toBe("NOT_FOUND");

    // Nothing changed.
    const rows = await harness.db
      .select({ status: appointmentTable.status })
      .from(appointmentTable)
      .where(eq(appointmentTable.id, id));
    expect(rows[0]?.status).toBe("pending");
  });

  it("the appointment's practitioner confirms a pending request → confirmed; the response is the GET-single shape", async () => {
    const id = await book(await seedSlot(doctorAProfileId, 51 * 24 * 60));

    const res = await confirm(id, doctorACookie);
    expect(res.status).toBe(200);
    const body = await json<{ id: string; status: string; patientName: string | null }>(res);
    expect(body.id).toBe(id);
    expect(body.status).toBe("confirmed");
    // Serialization contract (a5e733a): single-appointment responses name
    // neither side — persona names are LIST-only data.
    expect(body.patientName).toBeNull();

    // The confirm response is byte-for-byte what GET returns afterwards.
    const fetched = await harness.app.request(`/v1/appointments/${id}`, {
      headers: { cookie: doctorACookie },
    });
    expect(fetched.status).toBe(200);
    expect(await fetched.json()).toEqual(body);
  });

  it("enqueues the `confirmed` notification for the PATIENT only, in the same transaction", async () => {
    const id = await book(await seedSlot(doctorAProfileId, 52 * 24 * 60));
    const patientBefore = await outboxRowsFor(patientUserId);
    const doctorBefore = await outboxRowsFor(doctorAUserId);

    expect((await confirm(id, doctorACookie)).status).toBe(200);

    const patientAfter = await outboxRowsFor(patientUserId);
    expect(patientAfter.length).toBe(patientBefore.length + 1);
    // The exact P6.T3 plan row for the practitioner-driven confirm: the
    // `confirmed` scenario, patient recipient, email channel dedup key.
    const fresh = patientAfter.find(
      (row) => row.scenario === "appointment-confirmed" && row.dedupKey?.includes(id),
    );
    expect(fresh?.dedupKey).toBe(`appointment-confirmed:${id}:patient:email`);
    // The practitioner DROVE the confirm — no self-notification.
    expect((await outboxRowsFor(doctorAUserId)).length).toBe(doctorBefore.length);
  });

  it("a second confirm is a 409 APPOINTMENT_STATE_INVALID — confirmed is already firm", async () => {
    const id = await book(await seedSlot(doctorAProfileId, 53 * 24 * 60));
    expect((await confirm(id, doctorACookie)).status).toBe(200);

    const again = await confirm(id, doctorACookie);
    expect(again.status).toBe(409);
    expect((await json<{ error: { code: string } }>(again)).error.code).toBe(
      "APPOINTMENT_STATE_INVALID",
    );
  });

  it("the state machine admits only pending: cancelled/completed/no_show all 409", async () => {
    // cancelled: book then cancel, then try to confirm.
    const cancelledId = await book(await seedSlot(doctorAProfileId, 54 * 24 * 60));
    expect(
      (
        await harness.app.request(`/v1/appointments/${cancelledId}/cancel`, {
          method: "POST",
          headers: { cookie: patientCookie },
        })
      ).status,
    ).toBe(200);
    const cancelledRes = await confirm(cancelledId, doctorACookie);
    expect(cancelledRes.status).toBe(409);
    expect((await json<{ error: { code: string } }>(cancelledRes)).error.code).toBe(
      "APPOINTMENT_STATE_INVALID",
    );

    // completed and no_show (terminal statuses never reachable from here —
    // seeded directly). Drive every attempt, then assert: no awaits in loop.
    const terminalIds = await Promise.all(
      // DISTINCT windows: the unique (practitioner, starts_at) index rejects
      // same-millisecond collisions when these fixtures run in parallel.
      (["completed", "no_show"] as const).map((status, i) =>
        seedAppointment(status, (55 + i) * 24 * 60),
      ),
    );
    const terminalAttempts = await Promise.all(terminalIds.map((id) => confirm(id, doctorACookie)));
    const terminalCodes = await Promise.all(
      terminalAttempts.map((res) => json<{ error: { code: string } }>(res)),
    );
    for (const [index, res] of terminalAttempts.entries()) {
      expect(res.status).toBe(409);
      expect(terminalCodes[index]?.error.code).toBe("APPOINTMENT_STATE_INVALID");
    }
  });

  it("a pending request whose slot already started → 409 APPOINTMENT_STARTED", async () => {
    // Past slot + pending status, seeded directly (the booking endpoint refuses
    // past slots — same pattern as the cancel/reschedule suites).
    const slotId = crypto.randomUUID();
    await harness.db.insert(availabilitySlot).values({
      id: slotId,
      practitionerProfileId: doctorAProfileId,
      startsAt: new Date(Date.now() - 2 * 60_000),
      endsAt: new Date(Date.now() + 58 * 60_000),
      consultationTypes: ["in_person"],
    });
    const id = crypto.randomUUID();
    await harness.db.insert(appointmentTable).values({
      id,
      patientUserId,
      practitionerProfileId: doctorAProfileId,
      slotId,
      consultationOfferingId: offeringAId,
      consultationType: "in_person",
      startsAt: new Date(Date.now() - 2 * 60_000),
      endsAt: new Date(Date.now() + 58 * 60_000),
      priceXaf: 5000,
      cancellationNoticeHours: 24,
    });

    const res = await confirm(id, doctorACookie);
    expect(res.status).toBe(409);
    expect((await json<{ error: { code: string } }>(res)).error.code).toBe("APPOINTMENT_STARTED");

    // The state stays pending — a started request is left for the completion
    // flow, not silently confirmed.
    const rows = await harness.db
      .select({ status: appointmentTable.status })
      .from(appointmentTable)
      .where(and(eq(appointmentTable.id, id), eq(appointmentTable.status, "pending")));
    expect(rows).toHaveLength(1);
  });
});
