import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { practitionerProfile } from "@/db/schema/practitioner-profile";
import { profession } from "@/db/schema/profession";
import { createTestHarness, type TestHarness } from "../support/app-harness";

// SAFETY: API tests call endpoints with known response contracts and assert on those shapes.
const json = <T>(res: Response): Promise<T> => res.json() as Promise<T>;
const PROFESSION_ID = "00000000-0000-4000-8000-000000000091";

type SearchBody = {
  readonly data: ReadonlyArray<{ id: string; distanceKm: number | null }>;
};

describe("geocoding + distance API (real DB)", () => {
  let harness: TestHarness;
  let searcher: string;
  let doualaId: string;
  let garouaId: string;
  let noLocId: string;
  let noLocCookie: string;

  const coordsOf = async (
    id: string,
  ): Promise<{ latitude: number | null; longitude: number | null }> => {
    const rows = await harness.db
      .select({ latitude: practitionerProfile.latitude, longitude: practitionerProfile.longitude })
      .from(practitionerProfile)
      .where(eq(practitionerProfile.id, id));
    return rows[0] ?? { latitude: null, longitude: null };
  };

  const makeDoctor = async (
    email: string,
    location: string | undefined,
    verify: boolean,
  ): Promise<{ id: string; cookie: string }> => {
    const cookie = await harness.signUpAndVerify(email, "password12345", "Doc");
    const userId = await harness.userIdFor(email);
    const base = {
      role: "doctor",
      professionId: PROFESSION_ID,
      surname: "Doc",
      givenNames: "Doc",
      consentVersion: "1.0",
      acceptTerms: true,
    };
    const register = location === undefined ? base : { ...base, location };
    const id = (
      await json<{ id: string }>(await harness.post("/v1/practitioners/register", register, cookie))
    ).id;
    await harness.post(
      "/v1/practitioners/me/credentials",
      {
        cmcRegistrationNumber: `CMC-${email}`,
        nicNumber: `NIC-${email}`,
        cmcCertificateFileKey: `practitioner-documents/${userId}/cmc`,
        nicFileKey: `practitioner-documents/${userId}/nic`,
        profilePhotoFileKey: `profile-photos/${userId}/photo`,
      },
      cookie,
    );
    if (verify) {
      const adminCookie = await harness.signUpAndVerify(`admin-${email}`, "password12345", "Ad");
      await harness.promoteToAdmin(`admin-${email}`);
      await harness.post(`/v1/admin/verifications/${id}/approve`, {}, adminCookie);
    }
    return { id, cookie };
  };

  beforeAll(async () => {
    harness = await createTestHarness();
    await harness.db
      .insert(profession)
      .values({ id: PROFESSION_ID, nameEn: "Doctor", nameFr: "Médecin", prefixHint: "Dr." });

    doualaId = (await makeDoctor("geo-douala@example.com", "Douala", true)).id;
    garouaId = (await makeDoctor("geo-garoua@example.com", "Garoua", true)).id;
    const noLoc = await makeDoctor("geo-noloc@example.com", undefined, false);
    noLocId = noLoc.id;
    noLocCookie = noLoc.cookie;

    searcher = await harness.signUpAndVerify("geo-searcher@example.com", "password12345", "Pat");
  });

  afterAll(() => harness.dispose());

  it("geocodes a known city on registration", async () => {
    const coords = await coordsOf(doualaId);
    expect(coords.latitude).toBeCloseTo(4.05, 2);
    expect(coords.longitude).toBeCloseTo(9.7, 2);
  });

  it("leaves coordinates null when no location is given (save still succeeds)", async () => {
    const coords = await coordsOf(noLocId);
    expect(coords.latitude).toBeNull();
    expect(coords.longitude).toBeNull();
  });

  it("re-geocodes when the location changes via PATCH", async () => {
    const res = await harness.app.request("/v1/practitioners/me", {
      method: "PATCH",
      headers: { "content-type": "application/json", cookie: noLocCookie },
      body: JSON.stringify({ location: "Kribi" }),
    });
    expect(res.status).toBe(200);
    const coords = await coordsOf(noLocId);
    expect(coords.latitude).toBeCloseTo(2.94, 2);
    expect(coords.longitude).toBeCloseTo(9.91, 2);
  });

  it("sorts verified practitioners by distance from the searcher", async () => {
    const res = await harness.app.request(
      "/v1/practitioners?sort=distance&order=asc&lat=4.05&lng=9.7",
      { headers: { cookie: searcher } },
    );
    expect(res.status).toBe(200);
    const body = await json<SearchBody>(res);
    expect(body.data.map((c) => c.id)).toEqual([doualaId, garouaId]);
    expect(body.data[0]?.distanceKm).toBeCloseTo(0, 0);
    expect(body.data[1]?.distanceKm ?? 0).toBeGreaterThan(500);
  });
});
