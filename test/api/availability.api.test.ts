import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { profession } from "@/db/schema/profession";
import { createTestHarness, type TestHarness } from "../support/app-harness";

// SAFETY: API tests call endpoints with known response contracts and assert on those shapes.
const json = <T>(res: Response): Promise<T> => res.json() as Promise<T>;
const PROFESSION_ID = "00000000-0000-4000-8000-000000000081";
const CLIENT_SLOT_ID = "0198e3f0-5000-7000-8000-000000000001";

// Seven days ahead stays inside the public schedule's canonical 60-day horizon.
const FUTURE_DAY = new Date(Date.now() + 7 * 86_400_000).toISOString().slice(0, 10);
const future = (hour: number): string =>
  `${FUTURE_DAY}T${String(hour).padStart(2, "0")}:00:00.000Z`;
const PAST = "2000-01-01T09:00:00.000Z";

describe("availability API (real DB)", () => {
  let harness: TestHarness;
  let docCookie: string;
  let otherDocCookie: string;
  let otherLocationId: string;
  let patientCookie: string;
  let doctorId: string;

  const createSlot = (startsAt: string, endsAt: string, cookie: string): Promise<Response> =>
    harness.post("/v1/practitioners/me/availability", { startsAt, endsAt }, cookie);

  beforeAll(async () => {
    harness = await createTestHarness();
    await harness.db
      .insert(profession)
      .values({ id: PROFESSION_ID, nameEn: "Doctor", nameFr: "Médecin", prefixHint: "Dr." });

    const adminCookie = await harness.signUpAndVerify(
      "av-admin@example.com",
      "password12345",
      "Ad",
    );
    await harness.promoteToAdmin("av-admin@example.com");

    docCookie = await harness.signUpAndVerify("av-doc@example.com", "password12345", "Doc");
    const doctorUserId = await harness.userIdFor("av-doc@example.com");
    doctorId = (
      await json<{ id: string }>(
        await harness.post(
          "/v1/practitioners/register",
          {
            role: "doctor",
            professionId: PROFESSION_ID,
            surname: "Nkemtaji",
            givenNames: "Emmanuel",
            consentVersion: "1.0",
            acceptTerms: true,
          },
          docCookie,
        ),
      )
    ).id;
    await harness.post(
      "/v1/practitioners/me/credentials",
      {
        cmcRegistrationNumber: "CMC-AV",
        nicNumber: "NIC-AV",
        cmcCertificateFileKey: `practitioner-documents/${doctorUserId}/cmc`,
        nicFileKey: `practitioner-documents/${doctorUserId}/nic`,
        profilePhotoFileKey: `profile-photos/${doctorUserId}/photo`,
      },
      docCookie,
    );
    await harness.post(`/v1/admin/verifications/${doctorId}/approve`, {}, adminCookie);

    otherDocCookie = await harness.signUpAndVerify(
      "av-other-doc@example.com",
      "password12345",
      "Other Doc",
    );
    await harness.post(
      "/v1/practitioners/register",
      {
        role: "doctor",
        professionId: PROFESSION_ID,
        surname: "Other",
        givenNames: "Doctor",
        consentVersion: "1.0",
        acceptTerms: true,
      },
      otherDocCookie,
    );
    otherLocationId = (
      await json<{ readonly id: string }>(
        await harness.post(
          "/v1/practitioners/me/locations",
          {
            label: "Other clinic",
            addressLine1: "Other street",
            city: "Douala",
            region: "Littoral",
            consultationTypes: ["in_person"],
          },
          otherDocCookie,
        ),
      )
    ).id;

    patientCookie = await harness.signUpAndVerify("av-patient@example.com", "password12345", "Pat");
  });

  afterAll(() => harness.dispose());

  it("publishes a slot (201) and lists it", async () => {
    const res = await createSlot(future(9), future(10), docCookie);
    expect(res.status).toBe(201);
    const list = await json<{ data: ReadonlyArray<{ status: string }>; meta: { count: number } }>(
      await harness.app.request("/v1/practitioners/me/availability", {
        headers: { cookie: docCookie },
      }),
    );
    expect(list.meta.count).toBe(1);
    expect(list.data[0]?.status).toBe("open");
  });

  it("surfaces the next available slot on the public profile", async () => {
    const body = await json<{ nextAvailableAt: string | null }>(
      await harness.app.request(`/v1/practitioners/${doctorId}`, {
        headers: { cookie: patientCookie },
      }),
    );
    expect(body.nextAvailableAt).toBe(future(9));
  });

  it("rejects end <= start (422)", async () => {
    const res = await createSlot(future(11), future(11), docCookie);
    expect(res.status).toBe(422);
  });

  it("rejects a slot in the past (422)", async () => {
    const res = await createSlot(PAST, "2000-01-01T10:00:00.000Z", docCookie);
    expect(res.status).toBe(422);
  });

  it("rejects an overlapping slot (409)", async () => {
    const res = await createSlot(future(9), future(10), docCookie); // same window as the first
    expect(res.status).toBe(409);
    const err = await json<{ error: { code: string } }>(res);
    expect(err.error.code).toBe("SLOT_OVERLAP");
  });

  it("preserves a client UUIDv7 and rejects reusing it", async () => {
    const created = await harness.post(
      "/v1/practitioners/me/availability",
      { id: CLIENT_SLOT_ID, startsAt: future(16), endsAt: future(17) },
      docCookie,
    );
    expect(created.status).toBe(201);
    expect((await json<{ readonly id: string }>(created)).id).toBe(CLIENT_SLOT_ID);

    const duplicate = await harness.post(
      "/v1/practitioners/me/availability",
      { id: CLIENT_SLOT_ID, startsAt: future(17), endsAt: future(18) },
      docCookie,
    );
    expect(duplicate.status).toBe(409);
  });

  it("paginates slots, rejects malformed cursors, and requires authentication", async () => {
    const firstResponse = await harness.app.request("/v1/practitioners/me/availability?limit=1", {
      headers: { cookie: docCookie },
    });
    expect(firstResponse.status).toBe(200);
    const first = await json<{
      readonly data: ReadonlyArray<{ readonly id: string }>;
      readonly meta: { readonly nextCursor: string | null; readonly hasNextPage: boolean };
    }>(firstResponse);
    expect(first.data).toHaveLength(1);
    expect(first.meta.hasNextPage).toBe(true);
    const second = await json<{ readonly data: ReadonlyArray<{ readonly id: string }> }>(
      await harness.app.request(
        `/v1/practitioners/me/availability?limit=1&cursor=${encodeURIComponent(first.meta.nextCursor ?? "")}`,
        { headers: { cookie: docCookie } },
      ),
    );
    expect(second.data[0]?.id).not.toBe(first.data[0]?.id);
    expect(
      (
        await harness.app.request("/v1/practitioners/me/availability?cursor=invalid", {
          headers: { cookie: docCookie },
        })
      ).status,
    ).toBe(422);
    expect((await harness.app.request("/v1/practitioners/me/availability")).status).toBe(401);
  });

  it("forbids a non-practitioner (403)", async () => {
    const res = await createSlot(future(14), future(15), patientCookie);
    expect(res.status).toBe(403);
  });

  it("rejects a manual slot that references another practitioner's location", async () => {
    const response = await harness.post(
      "/v1/practitioners/me/availability",
      {
        startsAt: future(20),
        endsAt: future(21),
        consultationTypes: ["in_person"],
        locationId: otherLocationId,
      },
      docCookie,
    );
    expect(response.status).toBe(422);
  });

  it("cancels a slot (204) then 404s a second cancel", async () => {
    const created = await json<{ id: string }>(await createSlot(future(12), future(13), docCookie));
    const del = await harness.app.request(`/v1/practitioners/me/availability/${created.id}`, {
      method: "DELETE",
      headers: { cookie: docCookie },
    });
    expect(del.status).toBe(204);
    const again = await harness.app.request(`/v1/practitioners/me/availability/${created.id}`, {
      method: "DELETE",
      headers: { cookie: docCookie },
    });
    expect(again.status).toBe(404);
  });

  it("does not let another practitioner cancel an owned slot", async () => {
    const created = await json<{ id: string }>(await createSlot(future(18), future(19), docCookie));
    expect(
      (
        await harness.app.request(`/v1/practitioners/me/availability/${created.id}`, {
          method: "DELETE",
          headers: { cookie: otherDocCookie },
        })
      ).status,
    ).toBe(404);
  });
});
