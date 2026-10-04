import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { user } from "@/db/schema/auth";
import { appointment as appointmentTable } from "@/db/schema/appointment";
import { availabilitySlot } from "@/db/schema/availability-slot";
import { consultationOffering } from "@/db/schema/consultation-offering";
import { notificationOutbox } from "@/db/schema/notification-outbox";
import { practitionerProfile } from "@/db/schema/practitioner-profile";
import { profession } from "@/db/schema/profession";
import { createTestHarness, type TestHarness } from "../support/app-harness";

// SAFETY: API tests call endpoints with known response contracts and immediately assert on those shapes.
const json = <T>(res: Response): Promise<T> => res.json() as Promise<T>;

/**
 * P3.T3 — booking endpoint contracts against a real Postgres (Docker/CI tier).
 * Per endpoint: auth, happy path, the stable error codes for policy violations
 * (SLOT_TAKEN / APPOINTMENT_STATE_INVALID / APPOINTMENT_STARTED), ownership
 * scoping (404, never existence leaks), and pagination.
 */
describe("appointments API (real DB)", () => {
  let harness: TestHarness;
  let patientCookie: string;
  let otherCookie: string;
  let doctorCookie: string;
  let dependentId: string;
  let practitionerId: string;
  let otherPractitionerId: string;
  let offeringId: string;
  let mismatchedOfferingId: string;
  let patientUserId: string;

  /** A future 60-minute in_person slot owned by `profileId`. */
  const seedSlot = async (
    profileId: string,
    minutesAhead: number,
    types: Array<"in_person" | "video" | "home_visit"> = ["in_person"],
  ): Promise<string> => {
    const slotId = crypto.randomUUID();
    const startsAt = new Date(Date.now() + minutesAhead * 60_000);
    await harness.db.insert(availabilitySlot).values({
      id: slotId,
      practitionerProfileId: profileId,
      startsAt,
      endsAt: new Date(startsAt.getTime() + 60 * 60_000),
      consultationTypes: types,
    });
    return slotId;
  };

  const book = (
    cookie: string,
    body: { slotId: string; offeringId: string; dependentId?: string },
  ) => harness.post("/v1/appointments", body, cookie);

  const slotStatus = async (slotId: string) => {
    const rows = await harness.db
      .select({ status: availabilitySlot.status })
      .from(availabilitySlot)
      .where(eq(availabilitySlot.id, slotId));
    return rows[0]?.status;
  };

  beforeAll(async () => {
    harness = await createTestHarness();
    patientCookie = await harness.signUpAndVerify("booker@example.com", "password12345", "Book Er");
    otherCookie = await harness.signUpAndVerify("other@example.com", "password12345", "Oth Er");
    patientUserId = await harness.userIdFor("booker@example.com");

    // The practitioner signs up through the real flow (a session cookie is
    // needed to read their agenda), then is granted the doctor role in place —
    // onboarding flows are the api tier's own tests.
    doctorCookie = await harness.signUpAndVerify("doctor@example.com", "password12345", "Doc Tor");
    await harness.db
      .update(user)
      .set({ role: "doctor" })
      .where(eq(user.email, "doctor@example.com"));

    const professionId = crypto.randomUUID();
    await harness.db
      .insert(profession)
      .values({ id: professionId, nameEn: "Doctor", nameFr: "Médecin" });
    practitionerId = crypto.randomUUID();
    await harness.db.insert(practitionerProfile).values({
      id: practitionerId,
      userId: await harness.userIdFor("doctor@example.com"),
      professionId,
    });
    // A second practitioner (no login needed) to prove cross-practitioner slots are rejected.
    otherPractitionerId = crypto.randomUUID();
    await harness.db.insert(user).values({
      id: "user-doctor-b",
      name: "Doctor B",
      email: "doctor-b@example.com",
      emailVerified: true,
    });
    await harness.db.insert(practitionerProfile).values({
      id: otherPractitionerId,
      userId: "user-doctor-b",
      professionId,
    });
    offeringId = crypto.randomUUID();
    await harness.db.insert(consultationOffering).values({
      id: offeringId,
      practitionerProfileId: practitionerId,
      consultationType: "in_person",
      durationMin: 60,
      priceXaf: 5000,
    });
    // Same practitioner, different type/duration — coherence failures.
    mismatchedOfferingId = crypto.randomUUID();
    await harness.db.insert(consultationOffering).values({
      id: mismatchedOfferingId,
      practitionerProfileId: practitionerId,
      consultationType: "video",
      durationMin: 30,
      priceXaf: 2500,
    });

    const created = await harness.post(
      "/v1/dependents",
      {
        surname: "Kana",
        givenNames: "Petit",
        dateOfBirth: "2015-03-02",
        sex: "female",
        relationship: "child",
      },
      patientCookie,
    );
    expect(created.status).toBe(201);
    dependentId = (await json<{ id: string }>(created)).id;
  }, 120_000);

  afterAll(() => harness.dispose());

  describe("POST /v1/appointments", () => {
    it("requires a session", async () => {
      const slotId = await seedSlot(practitionerId, 7 * 24 * 60);
      expect((await book(slotId, { slotId, offeringId })).status).toBe(401);
    });

    it("books a slot and snapshots the commercial terms; the slot flips to booked", async () => {
      const slotId = await seedSlot(practitionerId, 8 * 24 * 60);
      const res = await book(patientCookie, { slotId, offeringId });
      expect(res.status).toBe(201);
      const body = await json<{
        status: string;
        priceXaf: number;
        cancellationNoticeHours: number;
        cancellationFeeXaf: number;
        lateCancellation: boolean;
        cancelledAt: string | null;
        cancelledByUserId: string | null;
        dependentId: string | null;
        patientUserId: string;
        startsAt: string;
      }>(res);
      expect(body.status).toBe("pending");
      expect(body.priceXaf).toBe(5000);
      expect(body.cancellationNoticeHours).toBe(24);
      expect(body.cancellationFeeXaf).toBe(0);
      expect(body.lateCancellation).toBe(false);
      expect(body.cancelledAt).toBeNull();
      expect(body.dependentId).toBeNull();
      expect(body.patientUserId).toBe(patientUserId);
      // startsAt mirrors the slot exactly (ISO string).
      const slots = await harness.db
        .select({ startsAt: availabilitySlot.startsAt })
        .from(availabilitySlot)
        .where(eq(availabilitySlot.id, slotId));
      expect(body.startsAt).toBe(slots[0]?.startsAt.toISOString());
      expect(await slotStatus(slotId)).toBe("booked");
    });

    it("returns 409 SLOT_TAKEN (localized) for a second booking on a booked slot", async () => {
      const slotId = await seedSlot(practitionerId, 9 * 24 * 60);
      expect((await book(patientCookie, { slotId, offeringId })).status).toBe(201);
      const loser = await book(otherCookie, { slotId, offeringId });
      expect(loser.status).toBe(409);
      const body = await json<{ error: { code: string; message: string } }>(loser);
      expect(body.error.code).toBe("SLOT_TAKEN");
      const fr = await harness.app.request("/v1/appointments", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "accept-language": "fr",
          cookie: otherCookie,
        },
        body: JSON.stringify({ slotId, offeringId }),
      });
      expect((await json<{ error: { message: string } }>(fr)).error.message).toContain("réservé");
    });

    it("404s an unknown slot or offering, 422s coherence failures", async () => {
      const unknown = await book(patientCookie, { slotId: crypto.randomUUID(), offeringId });
      expect(unknown.status).toBe(404);

      const unknownOffering = await book(patientCookie, {
        slotId: await seedSlot(practitionerId, 10 * 24 * 60),
        offeringId: crypto.randomUUID(),
      });
      expect(unknownOffering.status).toBe(404);

      const slotId = await seedSlot(practitionerId, 11 * 24 * 60);
      const mismatch = await book(patientCookie, { slotId, offeringId: mismatchedOfferingId });
      expect(mismatch.status).toBe(422);
      const body = await json<{ error: { code: string } }>(mismatch);
      expect(body.error.code).toBe("VALIDATION_FAILED");

      // A past slot is data hygiene (422), not contention (409).
      const pastSlotId = crypto.randomUUID();
      await harness.db.insert(availabilitySlot).values({
        id: pastSlotId,
        practitionerProfileId: practitionerId,
        startsAt: new Date(Date.now() - 60 * 60_000),
        endsAt: new Date(Date.now() + 60_000),
        consultationTypes: ["in_person"],
      });
      expect((await book(patientCookie, { slotId: pastSlotId, offeringId })).status).toBe(422);
    });

    it("books for a managed dependent; an unrelated account gets 403", async () => {
      const slotId = await seedSlot(practitionerId, 12 * 24 * 60);
      const own = await book(patientCookie, { slotId, offeringId, dependentId });
      expect(own.status).toBe(201);
      expect((await json<{ dependentId: string | null }>(own)).dependentId).toBe(dependentId);

      const unlinkedSlot = await seedSlot(practitionerId, 13 * 24 * 60);
      const unlinked = await book(otherCookie, { slotId: unlinkedSlot, offeringId, dependentId });
      expect(unlinked.status).toBe(403);
      expect((await json<{ error: { code: string } }>(unlinked)).error.code).toBe("FORBIDDEN");
    });
  });

  describe("GET /v1/appointments", () => {
    it("requires a session", async () => {
      expect((await harness.app.request("/v1/appointments")).status).toBe(401);
    });

    it("lists the caller's own + dependents' bookings, never other accounts'", async () => {
      const mineSlot = await seedSlot(practitionerId, 14 * 24 * 60);
      const mine = await book(patientCookie, { slotId: mineSlot, offeringId });
      const otherSlot = await seedSlot(practitionerId, 15 * 24 * 60);
      const theirs = await book(otherCookie, { slotId: otherSlot, offeringId });
      expect(theirs.status).toBe(201);

      const res = await harness.app.request("/v1/appointments?limit=100", {
        headers: { cookie: patientCookie },
      });
      expect(res.status).toBe(200);
      const page = await json<{
        data: ReadonlyArray<{ id: string; patientUserId: string }>;
        meta: { count: number; limit: number; nextCursor: string | null; hasNextPage: boolean };
      }>(res);
      expect(page.meta.limit).toBe(100);
      const ids = page.data.map((a) => a.id);
      expect(ids).toContain((await json<{ id: string }>(mine)).id);
      expect(ids).not.toContain((await json<{ id: string }>(theirs)).id);
      // Every visible row belongs to the caller (own or dependent bookings).
      for (const row of page.data) expect(row.patientUserId).toBe(patientUserId);
    });

    it("paginates with an opaque (startsAt, id) cursor", async () => {
      // A dedicated account with exactly 3 bookings makes the page math exact.
      const cookie = await harness.signUpAndVerify(
        "paginator@example.com",
        "password12345",
        "Pagina Tor",
      );
      const starts: string[] = [];
      // Unrolled (lint bans sequential awaits in loops; 3 fixed bookings).
      const firstSlot = await seedSlot(practitionerId, 16 * 24 * 60);
      const firstBooking = await book(cookie, { slotId: firstSlot, offeringId });
      expect(firstBooking.status).toBe(201);
      starts.push((await json<{ startsAt: string }>(firstBooking)).startsAt);
      const secondSlot = await seedSlot(practitionerId, 17 * 24 * 60);
      const secondBooking = await book(cookie, { slotId: secondSlot, offeringId });
      expect(secondBooking.status).toBe(201);
      starts.push((await json<{ startsAt: string }>(secondBooking)).startsAt);
      const thirdSlot = await seedSlot(practitionerId, 18 * 24 * 60);
      const thirdBooking = await book(cookie, { slotId: thirdSlot, offeringId });
      expect(thirdBooking.status).toBe(201);
      starts.push((await json<{ startsAt: string }>(thirdBooking)).startsAt);

      const pageOne = await harness.app.request("/v1/appointments?limit=2", {
        headers: { cookie },
      });
      expect(pageOne.status).toBe(200);
      const first = await json<{
        data: ReadonlyArray<{ id: string; startsAt: string }>;
        meta: { count: number; limit: number; nextCursor: string | null; hasNextPage: boolean };
      }>(pageOne);
      expect(first.data).toHaveLength(2);
      expect(first.meta.limit).toBe(2);
      expect(first.meta.hasNextPage).toBe(true);
      expect(first.meta.nextCursor).not.toBeNull();

      const pageTwo = await harness.app.request(
        `/v1/appointments?limit=2&cursor=${first.meta.nextCursor}`,
        { headers: { cookie } },
      );
      const second = await json<{
        data: ReadonlyArray<{ id: string; startsAt: string }>;
        meta: { nextCursor: string | null; hasNextPage: boolean };
      }>(pageTwo);
      expect(second.data).toHaveLength(1);
      expect(second.meta.hasNextPage).toBe(false);
      expect(second.meta.nextCursor).toBeNull();

      // Newest start first, no row repeated, exactly the 3 created bookings.
      const seen = [...first.data, ...second.data];
      expect(seen.map((a) => a.id)).toHaveLength(new Set(seen.map((a) => a.id)).size);
      expect(seen.map((a) => a.startsAt)).toEqual(starts.toReversed());
    });

    it("rejects a forged cursor with 422 and filters by status", async () => {
      const forged = await harness.app.request("/v1/appointments?cursor=not-a-cursor", {
        headers: { cookie: patientCookie },
      });
      expect(forged.status).toBe(422);

      const cancelledSlot = await seedSlot(practitionerId, 19 * 24 * 60);
      const created = await book(patientCookie, { slotId: cancelledSlot, offeringId });
      const id = (await json<{ id: string }>(created)).id;
      expect(
        (
          await harness.app.request(`/v1/appointments/${id}/cancel`, {
            method: "POST",
            headers: { cookie: patientCookie },
          })
        ).status,
      ).toBe(200);
      const cancelled = await harness.app.request("/v1/appointments?status=cancelled&limit=100", {
        headers: { cookie: patientCookie },
      });
      const page = await json<{ data: ReadonlyArray<{ id: string; status: string }> }>(cancelled);
      expect(page.data.length).toBeGreaterThan(0);
      for (const row of page.data) {
        expect(row.status).toBe("cancelled");
      }
      expect(page.data.some((row) => row.id === id)).toBe(true);

      const pending = await harness.app.request("/v1/appointments?status=pending&limit=100", {
        headers: { cookie: patientCookie },
      });
      const pendingPage = await json<{ data: ReadonlyArray<{ id: string }> }>(pending);
      expect(pendingPage.data.some((row) => row.id === id)).toBe(false);
    });

    it("scope=practitioner reads the agenda; patients are 403, profile-less doctors 404", async () => {
      const res = await harness.app.request("/v1/appointments?scope=practitioner&limit=100", {
        headers: { cookie: doctorCookie },
      });
      expect(res.status).toBe(200);
      const page = await json<{
        data: ReadonlyArray<{ id: string; practitionerProfileId: string }>;
      }>(res);
      // The agenda shows exactly this practitioner's calendar (incl. dependents' bookings).
      for (const row of page.data) expect(row.practitionerProfileId).toBe(practitionerId);
      expect(page.data.length).toBeGreaterThan(0);

      expect(
        (
          await harness.app.request("/v1/appointments?scope=practitioner", {
            headers: { cookie: patientCookie },
          })
        ).status,
      ).toBe(403);

      // A doctor role without a practitioner profile has no agenda to read.
      await harness.signUpAndVerify("role-only@example.com", "password12345", "Role Only");
      await harness.db
        .update(user)
        .set({ role: "doctor" })
        .where(eq(user.email, "role-only@example.com"));
      const roleOnlyCookie = await harness
        .post("/api/auth/sign-in/email", {
          email: "role-only@example.com",
          password: "password12345",
        })
        .then((r) => r.headers.get("set-cookie") ?? "");
      expect(
        (
          await harness.app.request("/v1/appointments?scope=practitioner", {
            headers: { cookie: roleOnlyCookie },
          })
        ).status,
      ).toBe(404);
    });
  });

  describe("GET /v1/appointments/{id}", () => {
    it("is visible to the patient and the practitioner; others get the 404 of an unknown id", async () => {
      const slotId = await seedSlot(practitionerId, 20 * 24 * 60);
      const created = await book(patientCookie, { slotId, offeringId });
      const id = (await json<{ id: string }>(created)).id;

      expect(
        (
          await harness.app.request(`/v1/appointments/${id}`, {
            headers: { cookie: patientCookie },
          })
        ).status,
      ).toBe(200);
      expect(
        (await harness.app.request(`/v1/appointments/${id}`, { headers: { cookie: doctorCookie } }))
          .status,
      ).toBe(200);
      const stranger = await harness.app.request(`/v1/appointments/${id}`, {
        headers: { cookie: otherCookie },
      });
      expect(stranger.status).toBe(404);
      const unknown = await harness.app.request(`/v1/appointments/${crypto.randomUUID()}`, {
        headers: { cookie: patientCookie },
      });
      expect(unknown.status).toBe(404);
      expect((await harness.app.request(`/v1/appointments/${id}`)).status).toBe(401);
    });
  });

  describe("POST /v1/appointments/{id}/reschedule", () => {
    it("moves the appointment, frees the old slot and books the new one", async () => {
      const oldSlot = await seedSlot(practitionerId, 21 * 24 * 60);
      const created = await book(patientCookie, { slotId: oldSlot, offeringId });
      const id = (await json<{ id: string }>(created)).id;
      const newSlot = await seedSlot(practitionerId, 22 * 24 * 60);

      const res = await harness.app.request(`/v1/appointments/${id}/reschedule`, {
        method: "POST",
        headers: { "content-type": "application/json", cookie: patientCookie },
        body: JSON.stringify({ slotId: newSlot }),
      });
      expect(res.status).toBe(200);
      const body = await json<{ id: string; slotId: string; startsAt: string }>(res);
      expect(body.slotId).toBe(newSlot);
      expect(await slotStatus(oldSlot)).toBe("open");
      expect(await slotStatus(newSlot)).toBe("booked");

      // Idempotent: rescheduling onto the current slot is a 200 no-op.
      const noop = await harness.app.request(`/v1/appointments/${id}/reschedule`, {
        method: "POST",
        headers: { "content-type": "application/json", cookie: patientCookie },
        body: JSON.stringify({ slotId: newSlot }),
      });
      expect(noop.status).toBe(200);
    });

    it("loses the race for a taken target slot with 409 SLOT_TAKEN — the booking keeps its slot", async () => {
      const oldSlot = await seedSlot(practitionerId, 23 * 24 * 60);
      const created = await book(patientCookie, { slotId: oldSlot, offeringId });
      const id = (await json<{ id: string }>(created)).id;
      const target = await seedSlot(practitionerId, 24 * 24 * 60);
      expect((await book(otherCookie, { slotId: target, offeringId })).status).toBe(201);

      const res = await harness.app.request(`/v1/appointments/${id}/reschedule`, {
        method: "POST",
        headers: { "content-type": "application/json", cookie: patientCookie },
        body: JSON.stringify({ slotId: target }),
      });
      expect(res.status).toBe(409);
      expect((await json<{ error: { code: string } }>(res)).error.code).toBe("SLOT_TAKEN");
      const rows = await harness.db
        .select({ slotId: appointmentTable.slotId })
        .from(appointmentTable)
        .where(eq(appointmentTable.id, id));
      expect(rows[0]?.slotId).toBe(oldSlot);
      expect(await slotStatus(oldSlot)).toBe("booked");
    });

    it("409s state violations and started appointments, 422s foreign-practitioner slots", async () => {
      // Cancelled appointment → APPOINTMENT_STATE_INVALID.
      const cancelledSlot = await seedSlot(practitionerId, 25 * 24 * 60);
      const cancelled = await book(patientCookie, { slotId: cancelledSlot, offeringId });
      const cancelledId = (await json<{ id: string }>(cancelled)).id;
      expect(
        (
          await harness.app.request(`/v1/appointments/${cancelledId}/cancel`, {
            method: "POST",
            headers: { cookie: patientCookie },
          })
        ).status,
      ).toBe(200);
      const target = await seedSlot(practitionerId, 26 * 24 * 60);
      const stateRes = await harness.app.request(`/v1/appointments/${cancelledId}/reschedule`, {
        method: "POST",
        headers: { "content-type": "application/json", cookie: patientCookie },
        body: JSON.stringify({ slotId: target }),
      });
      expect(stateRes.status).toBe(409);
      expect((await json<{ error: { code: string } }>(stateRes)).error.code).toBe(
        "APPOINTMENT_STATE_INVALID",
      );

      // Started appointment (seeded with a past slot) → APPOINTMENT_STARTED.
      const pastSlot = crypto.randomUUID();
      await harness.db.insert(availabilitySlot).values({
        id: pastSlot,
        practitionerProfileId: practitionerId,
        startsAt: new Date(Date.now() - 2 * 60_000),
        endsAt: new Date(Date.now() + 58 * 60_000),
        consultationTypes: ["in_person"],
      });
      const startedId = crypto.randomUUID();
      await harness.db.insert(appointmentTable).values({
        id: startedId,
        patientUserId,
        practitionerProfileId: practitionerId,
        slotId: pastSlot,
        consultationOfferingId: offeringId,
        consultationType: "in_person",
        startsAt: new Date(Date.now() - 2 * 60_000),
        endsAt: new Date(Date.now() + 58 * 60_000),
        priceXaf: 5000,
        cancellationNoticeHours: 24,
      });
      const startedRes = await harness.app.request(`/v1/appointments/${startedId}/reschedule`, {
        method: "POST",
        headers: { "content-type": "application/json", cookie: patientCookie },
        body: JSON.stringify({ slotId: await seedSlot(practitionerId, 27 * 24 * 60) }),
      });
      expect(startedRes.status).toBe(409);
      expect((await json<{ error: { code: string } }>(startedRes)).error.code).toBe(
        "APPOINTMENT_STARTED",
      );

      // Another practitioner's slot → VALIDATION_FAILED (slotId issue).
      const ownSlot = await seedSlot(practitionerId, 28 * 24 * 60);
      const own = await book(patientCookie, { slotId: ownSlot, offeringId });
      const ownId = (await json<{ id: string }>(own)).id;
      const foreignSlot = await seedSlot(otherPractitionerId, 29 * 24 * 60);
      const foreign = await harness.app.request(`/v1/appointments/${ownId}/reschedule`, {
        method: "POST",
        headers: { "content-type": "application/json", cookie: patientCookie },
        body: JSON.stringify({ slotId: foreignSlot }),
      });
      expect(foreign.status).toBe(422);
    });

    it("404s strangers (no existence leak) and unknown appointments", async () => {
      const slotId = await seedSlot(practitionerId, 30 * 24 * 60);
      const created = await book(patientCookie, { slotId, offeringId });
      const id = (await json<{ id: string }>(created)).id;
      const target = await seedSlot(practitionerId, 31 * 24 * 60);

      const stranger = await harness.app.request(`/v1/appointments/${id}/reschedule`, {
        method: "POST",
        headers: { "content-type": "application/json", cookie: otherCookie },
        body: JSON.stringify({ slotId: target }),
      });
      expect(stranger.status).toBe(404);
      expect(
        (
          await harness.app.request(`/v1/appointments/${crypto.randomUUID()}/reschedule`, {
            method: "POST",
            headers: { "content-type": "application/json", cookie: patientCookie },
            body: JSON.stringify({ slotId: target }),
          })
        ).status,
      ).toBe(404);
      // The stranger's attempt changed nothing.
      expect(await slotStatus(slotId)).toBe("booked");
      expect(await slotStatus(target)).toBe("open");
    });
  });

  describe("POST /v1/appointments/{id}/cancel", () => {
    it("cancels on time outside the notice window and frees the slot", async () => {
      const slotId = await seedSlot(practitionerId, 32 * 24 * 60); // 32h away, 24h window.
      const created = await book(patientCookie, { slotId, offeringId });
      const id = (await json<{ id: string }>(created)).id;

      const res = await harness.app.request(`/v1/appointments/${id}/cancel`, {
        method: "POST",
        headers: { cookie: patientCookie },
      });
      expect(res.status).toBe(200);
      const body = await json<{
        status: string;
        lateCancellation: boolean;
        cancelledAt: string | null;
        cancelledByUserId: string | null;
      }>(res);
      expect(body.status).toBe("cancelled");
      expect(body.lateCancellation).toBe(false);
      expect(body.cancelledAt).not.toBeNull();
      expect(body.cancelledByUserId).toBe(patientUserId);
      expect(await slotStatus(slotId)).toBe("open");
    });

    it("tracks a LATE cancellation inside the notice window (fee snapshot preserved)", async () => {
      const slotId = await seedSlot(practitionerId, 2 * 60); // 2h away — inside the 24h window.
      const created = await book(patientCookie, { slotId, offeringId });
      const id = (await json<{ id: string }>(created)).id;

      const res = await harness.app.request(`/v1/appointments/${id}/cancel`, {
        method: "POST",
        headers: { cookie: patientCookie },
      });
      expect(res.status).toBe(200);
      const body = await json<{ lateCancellation: boolean; cancellationFeeXaf: number }>(res);
      expect(body.lateCancellation).toBe(true);
      expect(body.cancellationFeeXaf).toBe(0);
    });

    it("a practitioner-initiated cancellation is never late", async () => {
      const slotId = await seedSlot(practitionerId, 60); // 1h away — inside the window.
      const created = await book(patientCookie, { slotId, offeringId });
      const id = (await json<{ id: string }>(created)).id;

      const res = await harness.app.request(`/v1/appointments/${id}/cancel`, {
        method: "POST",
        headers: { cookie: doctorCookie },
      });
      expect(res.status).toBe(200);
      const body = await json<{ lateCancellation: boolean; cancelledByUserId: string | null }>(res);
      expect(body.lateCancellation).toBe(false);
      expect(body.cancelledByUserId).not.toBe(patientUserId);
    });

    it("409s double cancellation and started appointments", async () => {
      const slotId = await seedSlot(practitionerId, 33 * 24 * 60);
      const created = await book(patientCookie, { slotId, offeringId });
      const id = (await json<{ id: string }>(created)).id;
      expect(
        (
          await harness.app.request(`/v1/appointments/${id}/cancel`, {
            method: "POST",
            headers: { cookie: patientCookie },
          })
        ).status,
      ).toBe(200);
      const again = await harness.app.request(`/v1/appointments/${id}/cancel`, {
        method: "POST",
        headers: { cookie: patientCookie },
      });
      expect(again.status).toBe(409);
      expect((await json<{ error: { code: string } }>(again)).error.code).toBe(
        "APPOINTMENT_STATE_INVALID",
      );

      const pastSlot = crypto.randomUUID();
      await harness.db.insert(availabilitySlot).values({
        id: pastSlot,
        practitionerProfileId: practitionerId,
        startsAt: new Date(Date.now() - 3 * 60_000),
        endsAt: new Date(Date.now() + 57 * 60_000),
        consultationTypes: ["in_person"],
      });
      const startedId = crypto.randomUUID();
      await harness.db.insert(appointmentTable).values({
        id: startedId,
        patientUserId,
        practitionerProfileId: practitionerId,
        slotId: pastSlot,
        consultationOfferingId: offeringId,
        consultationType: "in_person",
        startsAt: new Date(Date.now() - 3 * 60_000),
        endsAt: new Date(Date.now() + 57 * 60_000),
        priceXaf: 5000,
        cancellationNoticeHours: 24,
      });
      const started = await harness.app.request(`/v1/appointments/${startedId}/cancel`, {
        method: "POST",
        headers: { cookie: patientCookie },
      });
      expect(started.status).toBe(409);
      expect((await json<{ error: { code: string } }>(started)).error.code).toBe(
        "APPOINTMENT_STARTED",
      );
    });

    it("404s strangers and unknown ids; 401s anonymous callers", async () => {
      const slotId = await seedSlot(practitionerId, 34 * 24 * 60);
      const created = await book(patientCookie, { slotId, offeringId });
      const id = (await json<{ id: string }>(created)).id;

      expect(
        (
          await harness.app.request(`/v1/appointments/${id}/cancel`, {
            method: "POST",
            headers: { cookie: otherCookie },
          })
        ).status,
      ).toBe(404);
      expect(
        (
          await harness.app.request(`/v1/appointments/${crypto.randomUUID()}/cancel`, {
            method: "POST",
            headers: { cookie: patientCookie },
          })
        ).status,
      ).toBe(404);
      expect(
        (await harness.app.request(`/v1/appointments/${id}/cancel`, { method: "POST" })).status,
      ).toBe(401);
      // The stranger's attempt changed nothing.
      const rows = await harness.db
        .select({ status: appointmentTable.status })
        .from(appointmentTable)
        .where(eq(appointmentTable.id, id));
      expect(rows[0]?.status).toBe("pending");
    });
  });

  describe("P6.T4 — lifecycle notifications honour the stored preferences (real API + real outbox)", () => {
    /** Outbox rows recorded for one user (the enqueue-time gate's ground truth). */
    const outboxCount = async (userId: string): Promise<number> => {
      const rows = await harness.db
        .select({ id: notificationOutbox.id })
        .from(notificationOutbox)
        .where(eq(notificationOutbox.userId, userId));
      return rows.length;
    };

    const setAppointmentsEmail = async (enabled: boolean): Promise<void> => {
      const patched = await harness.app.request("/v1/me/notifications", {
        method: "PATCH",
        headers: { cookie: patientCookie, "content-type": "application/json" },
        body: JSON.stringify({
          preferences: [{ category: "appointments", email: enabled, sms: false, push: false }],
        }),
      });
      expect(patched.status).toBe(200);
    };

    it("appointments.email OFF → a booking enqueues NOTHING for the patient; the practitioner still learns", async () => {
      await setAppointmentsEmail(false);
      const patientBefore = await outboxCount(patientUserId);
      const doctorId = await harness.userIdFor("doctor@example.com");
      const doctorBefore = await outboxCount(doctorId);

      const slotId = await seedSlot(practitionerId, 40 * 24 * 60);
      const created = await book(patientCookie, { slotId, offeringId });
      expect(created.status).toBe(201);

      // The gate sits at ENQUEUE: a switched-off channel enqueues nothing, so
      // the outbox row count is the truth about what was ever meant to be sent.
      expect(await outboxCount(patientUserId)).toBe(patientBefore);
      // Gating is per RECIPIENT: the practitioner (code defaults, email on)
      // still gets the booking confirmation.
      expect(await outboxCount(doctorId)).toBe(doctorBefore + 1);
    });

    it("turning the preference back ON restores delivery on the next transition", async () => {
      await setAppointmentsEmail(true);
      const patientBefore = await outboxCount(patientUserId);

      const slotId = await seedSlot(practitionerId, 41 * 24 * 60);
      const created = await book(patientCookie, { slotId, offeringId });
      expect(created.status).toBe(201);

      expect(await outboxCount(patientUserId)).toBe(patientBefore + 1);
    });
  });
});
