import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { user } from "@/db/schema/auth";
import { availabilitySlot } from "@/db/schema/availability-slot";
import { consultationOffering } from "@/db/schema/consultation-offering";
import { practitionerProfile } from "@/db/schema/practitioner-profile";
import { profession } from "@/db/schema/profession";
import { createTestHarness, type TestHarness, testPassword } from "../support/app-harness";

// SAFETY: API tests call endpoints with known response contracts and immediately assert on those shapes.
const json = <T>(res: Response): Promise<T> => res.json() as Promise<T>;

/**
 * P3.T5 — the practitioner-configurable booking policy against a real
 * Postgres (Docker/CI tier): read/replace `GET|PUT
 * /v1/practitioners/me/booking-policy`, the snapshot stamped onto NEW
 * bookings, and the notice window actually biting at the boundary (late vs
 * on-time cancellation).
 */
describe("practitioner booking policy (real DB)", () => {
  let harness: TestHarness;
  let doctorCookie: string;
  let patientCookie: string;
  let practitionerProfileId: string;
  let offeringId: string;

  const seedSlot = async (minutesAhead: number): Promise<string> => {
    const slotId = crypto.randomUUID();
    const startsAt = new Date(Date.now() + minutesAhead * 60_000);
    await harness.db.insert(availabilitySlot).values({
      id: slotId,
      practitionerProfileId,
      startsAt,
      endsAt: new Date(startsAt.getTime() + 60 * 60_000),
      consultationTypes: ["in_person"],
    });
    return slotId;
  };

  beforeAll(async () => {
    harness = await createTestHarness();
    doctorCookie = await harness.signUpAndVerify(
      "policy-doc@example.com",
      testPassword("default"),
      "Doc Policy",
    );
    patientCookie = await harness.signUpAndVerify(
      "policy-patient@example.com",
      testPassword("default"),
      "Pat Ient",
    );
    await harness.db
      .update(user)
      .set({ role: "doctor" })
      .where(eq(user.email, "policy-doc@example.com"));

    const professionId = crypto.randomUUID();
    await harness.db
      .insert(profession)
      .values({ id: professionId, nameEn: "Doctor", nameFr: "Médecin" });
    practitionerProfileId = crypto.randomUUID();
    await harness.db.insert(practitionerProfile).values({
      id: practitionerProfileId,
      userId: await harness.userIdFor("policy-doc@example.com"),
      professionId,
    });
    offeringId = crypto.randomUUID();
    await harness.db.insert(consultationOffering).values({
      id: offeringId,
      practitionerProfileId,
      consultationType: "in_person",
      durationMin: 60,
      priceXaf: 5000,
    });
  }, 120_000);

  afterAll(() => harness.dispose());

  it("defaults to 24h notice and no fee; PUT replaces and GET reflects it", async () => {
    const initial = await harness.app.request("/v1/practitioners/me/booking-policy", {
      headers: { cookie: doctorCookie },
    });
    expect(initial.status).toBe(200);
    expect(await json<{ noticeHours: number; feeXaf: number }>(initial)).toEqual({
      noticeHours: 24,
      feeXaf: 0,
    });

    const put = await harness.app.request("/v1/practitioners/me/booking-policy", {
      method: "PUT",
      headers: { "content-type": "application/json", cookie: doctorCookie },
      body: JSON.stringify({ noticeHours: 1, feeXaf: 2500 }),
    });
    expect(put.status).toBe(200);
    expect(await json<{ noticeHours: number; feeXaf: number }>(put)).toEqual({
      noticeHours: 1,
      feeXaf: 2500,
    });

    const reread = await harness.app.request("/v1/practitioners/me/booking-policy", {
      headers: { cookie: doctorCookie },
    });
    expect(await json<{ noticeHours: number; feeXaf: number }>(reread)).toEqual({
      noticeHours: 1,
      feeXaf: 2500,
    });
  });

  it("is practitioner-only (403/404) and validates the ranges (422)", async () => {
    const policyBody = { noticeHours: 1, feeXaf: 0 };
    const patientGet = await harness.app.request("/v1/practitioners/me/booking-policy", {
      headers: { cookie: patientCookie },
    });
    const patientPut = await harness.app.request("/v1/practitioners/me/booking-policy", {
      method: "PUT",
      headers: { "content-type": "application/json", cookie: patientCookie },
      body: JSON.stringify(policyBody),
    });
    expect(patientGet.status).toBe(403);
    expect(patientPut.status).toBe(403);
    expect(
      (
        await harness.app.request("/v1/practitioners/me/booking-policy", {
          method: "PUT",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(policyBody),
        })
      ).status,
    ).toBe(401);

    // Doctor role WITHOUT a profile → 404.
    await harness.signUpAndVerify(
      "policy-roleless@example.com",
      testPassword("default"),
      "Role Less",
    );
    await harness.db
      .update(user)
      .set({ role: "doctor" })
      .where(eq(user.email, "policy-roleless@example.com"));
    const rolelessCookie = await harness
      .post("/api/auth/sign-in/email", {
        email: "policy-roleless@example.com",
        password: testPassword("default"),
      })
      .then((r) => r.headers.get("set-cookie") ?? "");
    expect(
      (
        await harness.app.request("/v1/practitioners/me/booking-policy", {
          headers: { cookie: rolelessCookie },
        })
      ).status,
    ).toBe(404);

    const tooWide = await harness.app.request("/v1/practitioners/me/booking-policy", {
      method: "PUT",
      headers: { "content-type": "application/json", cookie: doctorCookie },
      body: JSON.stringify({ noticeHours: 721, feeXaf: 0 }),
    });
    expect(tooWide.status).toBe(422);
    const negativeFee = await harness.app.request("/v1/practitioners/me/booking-policy", {
      method: "PUT",
      headers: { "content-type": "application/json", cookie: doctorCookie },
      body: JSON.stringify({ noticeHours: 24, feeXaf: -1 }),
    });
    expect(negativeFee.status).toBe(422);
  });

  it("stamps NEW bookings with the configured policy; existing bookings keep their snapshot", async () => {
    const early = await seedSlot(50 * 24 * 60); // booked under the 1h/2500 policy
    const booked = await harness.post(
      "/v1/appointments",
      { slotId: early, offeringId },
      patientCookie,
    );
    expect(booked.status).toBe(201);
    const first = await json<{
      id: string;
      cancellationNoticeHours: number;
      cancellationFeeXaf: number;
    }>(booked);
    expect(first.cancellationNoticeHours).toBe(1);
    expect(first.cancellationFeeXaf).toBe(2500);

    // The practitioner widens the window — the existing booking is untouched.
    const put = await harness.app.request("/v1/practitioners/me/booking-policy", {
      method: "PUT",
      headers: { "content-type": "application/json", cookie: doctorCookie },
      body: JSON.stringify({ noticeHours: 48, feeXaf: 1000 }),
    });
    expect(put.status).toBe(200);
    const reread = await harness.app.request(`/v1/appointments/${first.id}`, {
      headers: { cookie: patientCookie },
    });
    const unchanged = await json<{ cancellationNoticeHours: number; cancellationFeeXaf: number }>(
      reread,
    );
    expect(unchanged.cancellationNoticeHours).toBe(1);
    expect(unchanged.cancellationFeeXaf).toBe(2500);

    // ...while the NEXT booking carries the new values.
    const later = await seedSlot(51 * 24 * 60);
    const second = await harness.post(
      "/v1/appointments",
      { slotId: later, offeringId },
      patientCookie,
    );
    const secondBody = await json<{ cancellationNoticeHours: number; cancellationFeeXaf: number }>(
      second,
    );
    expect(secondBody.cancellationNoticeHours).toBe(48);
    expect(secondBody.cancellationFeeXaf).toBe(1000);
  });

  it("the configured window decides late vs on-time at the boundary", async () => {
    // Policy is 48h now: a slot 2h away is INSIDE the window → late...
    const soonSlot = await seedSlot(2 * 60);
    const soon = await harness.post(
      "/v1/appointments",
      { slotId: soonSlot, offeringId },
      patientCookie,
    );
    const soonId = (await json<{ id: string }>(soon)).id;
    const lateCancel = await harness.app.request(`/v1/appointments/${soonId}/cancel`, {
      method: "POST",
      headers: { cookie: patientCookie },
    });
    expect(lateCancel.status).toBe(200);
    expect((await json<{ lateCancellation: boolean }>(lateCancel)).lateCancellation).toBe(true);

    // ...and a slot 3 DAYS away is outside even the 48h window → on time.
    const farSlot = await seedSlot(52 * 24 * 60);
    const far = await harness.post(
      "/v1/appointments",
      { slotId: farSlot, offeringId },
      patientCookie,
    );
    const farId = (await json<{ id: string }>(far)).id;
    const onTime = await harness.app.request(`/v1/appointments/${farId}/cancel`, {
      method: "POST",
      headers: { cookie: patientCookie },
    });
    expect(onTime.status).toBe(200);
    expect((await json<{ lateCancellation: boolean }>(onTime)).lateCancellation).toBe(false);
  });
});
