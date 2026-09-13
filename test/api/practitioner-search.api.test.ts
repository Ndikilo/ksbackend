import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { profession } from "@/db/schema/profession";
import { createTestHarness, type TestHarness } from "../support/app-harness";

// SAFETY: API tests call endpoints with known response contracts and assert on those shapes.
const json = <T>(res: Response): Promise<T> => res.json() as Promise<T>;

const PROFESSION_DOCTOR = "00000000-0000-4000-8000-000000000061";
const PROFESSION_NURSE = "00000000-0000-4000-8000-000000000062";

type PractitionerCard = {
  readonly id: string;
  readonly specialty: string | null;
  readonly location: string | null;
  readonly consultationFeeXaf: number | null;
  readonly consultationTypes: ReadonlyArray<string> | null;
  readonly rating: { readonly average: number; readonly count: number };
  readonly nextAvailableAt: string | null;
  readonly distanceKm: number | null;
  readonly photoUrl: string | null;
};
type SearchBody = {
  readonly data: ReadonlyArray<PractitionerCard>;
  readonly meta: {
    readonly count: number;
    readonly page: number;
    readonly pageSize: number;
    readonly total: number;
    readonly pageCount: number;
    readonly hasNextPage: boolean;
    readonly hasPreviousPage: boolean;
  };
};

type DoctorSpec = {
  readonly email: string;
  readonly surname: string;
  readonly givenNames: string;
  readonly professionId?: string;
  readonly specialty?: string;
  readonly location?: string;
  readonly languagesSpoken?: ReadonlyArray<string>;
  readonly consultationFeeXaf?: number;
  readonly consultationTypes?: ReadonlyArray<string>;
  readonly verify?: boolean;
};

const search = async (harness: TestHarness, cookie: string, query: string): Promise<Response> =>
  harness.app.request(`/v1/practitioners${query}`, { headers: { cookie } });

describe("practitioner search API (real DB)", () => {
  let harness: TestHarness;
  let searcher: string;
  let adminCookie: string;
  const ids: Record<string, string> = {};

  const makeDoctor = async (spec: DoctorSpec): Promise<string> => {
    const cookie = await harness.signUpAndVerify(spec.email, "password12345", spec.givenNames);
    const userId = await harness.userIdFor(spec.email);
    const id = (
      await json<{ id: string }>(
        await harness.post(
          "/v1/practitioners/register",
          {
            role: spec.professionId === PROFESSION_NURSE ? "nurse" : "doctor",
            professionId: spec.professionId ?? PROFESSION_DOCTOR,
            surname: spec.surname,
            givenNames: spec.givenNames,
            consentVersion: "1.0",
            acceptTerms: true,
          },
          cookie,
        ),
      )
    ).id;
    await harness.post(
      "/v1/practitioners/me/credentials",
      {
        cmcRegistrationNumber: `CMC-${spec.email}`,
        nicNumber: `NIC-${spec.email}`,
        cmcCertificateFileKey: `practitioner-documents/${userId}/cmc`,
        nicFileKey: `practitioner-documents/${userId}/nic`,
        profilePhotoFileKey: `profile-photos/${userId}/photo`,
      },
      cookie,
    );
    await harness.app.request("/v1/practitioners/me", {
      method: "PATCH",
      headers: { "content-type": "application/json", cookie },
      body: JSON.stringify({
        specialty: spec.specialty,
        location: spec.location,
        languagesSpoken: spec.languagesSpoken,
        consultationFeeXaf: spec.consultationFeeXaf,
        consultationTypes: spec.consultationTypes,
      }),
    });
    if (spec.verify !== false) {
      await harness.post(`/v1/admin/verifications/${id}/approve`, {}, adminCookie);
    }
    return id;
  };

  beforeAll(async () => {
    harness = await createTestHarness();
    await harness.db.insert(profession).values([
      { id: PROFESSION_DOCTOR, nameEn: "Doctor", nameFr: "Médecin", prefixHint: "Dr." },
      { id: PROFESSION_NURSE, nameEn: "Nurse", nameFr: "Infirmier", prefixHint: null },
    ]);

    adminCookie = await harness.signUpAndVerify("search-admin@example.com", "password12345", "Ad");
    await harness.promoteToAdmin("search-admin@example.com");
    searcher = await harness.signUpAndVerify("search-patient@example.com", "password12345", "Pat");

    ids.cardioDouala = await makeDoctor({
      email: "cardio-douala@example.com",
      surname: "Nkemtaji",
      givenNames: "Emmanuel",
      specialty: "Cardiology",
      location: "Douala",
      languagesSpoken: ["fr", "en"],
      consultationFeeXaf: 15000,
      consultationTypes: ["in_person", "video"],
    });
    ids.pediatricsYaounde = await makeDoctor({
      email: "pediatrics-yaounde@example.com",
      surname: "Abena",
      givenNames: "Marie",
      specialty: "Pediatrics",
      location: "Yaoundé",
      languagesSpoken: ["fr"],
      consultationFeeXaf: 10000,
      consultationTypes: ["video"],
    });
    ids.cardioBafoussam = await makeDoctor({
      email: "cardio-bafoussam@example.com",
      surname: "Tchoua",
      givenNames: "Paul",
      specialty: "Cardiology",
      location: "Bafoussam",
      languagesSpoken: ["en"],
      consultationFeeXaf: 25000,
      consultationTypes: ["home_visit"],
    });
    ids.unverified = await makeDoctor({
      email: "cardio-unverified@example.com",
      surname: "Ghost",
      givenNames: "Unseen",
      specialty: "Cardiology",
      location: "Douala",
      consultationFeeXaf: 5000,
      verify: false,
    });
  });

  afterAll(() => harness.dispose());

  it("returns only verified practitioners as cards with offset metadata", async () => {
    const res = await search(harness, searcher, "");
    expect(res.status).toBe(200);
    const body = await json<SearchBody>(res);
    expect(body.meta.total).toBe(3);
    expect(body.meta.page).toBe(1);
    expect(body.meta.pageSize).toBe(20);
    expect(body.meta.hasNextPage).toBe(false);
    expect(body.meta.hasPreviousPage).toBe(false);
    const returnedIds = body.data.map((c) => c.id);
    expect(returnedIds).not.toContain(ids.unverified);
    const card = body.data.find((c) => c.id === ids.cardioDouala);
    expect(card?.rating).toEqual({ average: 0, count: 0 });
    expect(card?.nextAvailableAt).toBeNull();
    expect(card?.distanceKm).toBeNull();
    expect(card?.photoUrl).toBeTruthy();
    expect(card?.consultationTypes).toEqual(["in_person", "video"]);
  });

  it("filters by specialty and tolerates typos (trigram fuzzy)", async () => {
    const res = await search(harness, searcher, "?specialty=Cardiollogy");
    const body = await json<SearchBody>(res);
    const returnedIds = body.data.map((c) => c.id).toSorted();
    expect(returnedIds).toEqual([ids.cardioBafoussam, ids.cardioDouala].toSorted());
  });

  it("combines filters (specialty + city) and returns nothing when they don't intersect", async () => {
    const match = await json<SearchBody>(
      await search(harness, searcher, "?specialty=Cardiology&city=Douala"),
    );
    expect(match.data.map((c) => c.id)).toEqual([ids.cardioDouala]);

    const empty = await json<SearchBody>(
      await search(harness, searcher, "?specialty=Pediatrics&city=Bafoussam"),
    );
    expect(empty.meta.total).toBe(0);
    expect(empty.data).toEqual([]);
  });

  it("filters by language, consultation type, and fee range", async () => {
    const english = await json<SearchBody>(await search(harness, searcher, "?language=en"));
    expect(english.data.map((c) => c.id).toSorted()).toEqual(
      [ids.cardioDouala, ids.cardioBafoussam].toSorted(),
    );

    const video = await json<SearchBody>(
      await search(harness, searcher, "?consultationType=video"),
    );
    expect(video.data.map((c) => c.id).toSorted()).toEqual(
      [ids.cardioDouala, ids.pediatricsYaounde].toSorted(),
    );

    const cheap = await json<SearchBody>(
      await search(harness, searcher, "?feeMin=8000&feeMax=16000"),
    );
    expect(cheap.data.map((c) => c.id).toSorted()).toEqual(
      [ids.cardioDouala, ids.pediatricsYaounde].toSorted(),
    );
  });

  it("sorts by fee ascending and descending", async () => {
    const asc = await json<SearchBody>(await search(harness, searcher, "?sort=fee&order=asc"));
    expect(asc.data.map((c) => c.consultationFeeXaf)).toEqual([10000, 15000, 25000]);
    const desc = await json<SearchBody>(await search(harness, searcher, "?sort=fee&order=desc"));
    expect(desc.data.map((c) => c.consultationFeeXaf)).toEqual([25000, 15000, 10000]);
  });

  it("restricts to a profession id", async () => {
    const res = await search(harness, searcher, `?professionId=${PROFESSION_NURSE}`);
    const body = await json<SearchBody>(res);
    expect(body.meta.total).toBe(0);
  });

  it("paginates with page + pageSize and reports totals", async () => {
    const page1 = await json<SearchBody>(
      await search(harness, searcher, "?sort=fee&order=asc&pageSize=2&page=1"),
    );
    expect(page1.data.map((c) => c.consultationFeeXaf)).toEqual([10000, 15000]);
    expect(page1.meta).toMatchObject({
      total: 3,
      pageCount: 2,
      hasNextPage: true,
      hasPreviousPage: false,
    });

    const page2 = await json<SearchBody>(
      await search(harness, searcher, "?sort=fee&order=asc&pageSize=2&page=2"),
    );
    expect(page2.data.map((c) => c.consultationFeeXaf)).toEqual([25000]);
    expect(page2.meta).toMatchObject({ hasNextPage: false, hasPreviousPage: true });
  });

  it("rejects sort=distance without lat & lng (422)", async () => {
    const res = await search(harness, searcher, "?sort=distance");
    expect(res.status).toBe(422);
    const body = await json<{ error: { code: string } }>(res);
    expect(body.error.code).toBe("VALIDATION_FAILED");
  });

  it("reports the true total on a page past the last (empty page)", async () => {
    const body = await json<SearchBody>(await search(harness, searcher, "?pageSize=2&page=99"));
    expect(body.data).toEqual([]);
    expect(body.meta.total).toBe(3);
    expect(body.meta.pageCount).toBe(2);
    expect(body.meta.hasNextPage).toBe(false);
    expect(body.meta.hasPreviousPage).toBe(true);
  });

  it("requires a session", async () => {
    const res = await harness.app.request("/v1/practitioners");
    expect(res.status).toBe(401);
  });
});
