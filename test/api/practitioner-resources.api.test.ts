import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { profession } from "@/db/schema/profession";
import { createTestHarness, type TestHarness } from "../support/app-harness";

// SAFETY: API tests call endpoints with known response contracts and assert on those shapes.
const json = <T>(response: Response): Promise<T> => response.json() as Promise<T>;
type JsonValue =
  | string
  | number
  | boolean
  | null
  | { readonly [key: string]: JsonValue }
  | ReadonlyArray<JsonValue>;

const PROFESSION_ID = "0198e3f0-2000-7000-8000-000000000001";
const QUALIFICATION_ID = "0198e3f0-2000-7000-8000-000000000101";
const LOCATION_ID = "0198e3f0-2000-7000-8000-000000000201";
const OFFERING_ID = "0198e3f0-2000-7000-8000-000000000301";
const PAYOUT_ID = "0198e3f0-2000-7000-8000-000000000401";
const UNKNOWN_ID = "0198e3f0-2000-7000-8000-000000000999";

type ListBody = {
  readonly data: ReadonlyArray<{ readonly id: string }>;
  readonly meta: {
    readonly count: number;
    readonly limit: number;
    readonly nextCursor: null;
    readonly hasNextPage: false;
  };
};

describe("practitioner-owned resource APIs (real DB)", () => {
  let harness: TestHarness;
  let ownerCookie: string;
  let otherCookie: string;
  let patientCookie: string;
  let secondPayoutId: string;

  const request = async (
    method: string,
    path: string,
    cookie: string | undefined,
    body?: JsonValue,
  ): Promise<Response> =>
    await harness.app.request(path, {
      method,
      headers:
        body === undefined
          ? cookie === undefined
            ? undefined
            : { cookie }
          : cookie === undefined
            ? { "content-type": "application/json" }
            : { cookie, "content-type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });

  const register = async (email: string, name: string): Promise<string> => {
    const cookie = await harness.signUpAndVerify(email, "password12345", name);
    const response = await harness.post(
      "/v1/practitioners/register",
      {
        role: "doctor",
        professionId: PROFESSION_ID,
        surname: name,
        givenNames: "Test",
        consentVersion: "1.0",
        acceptTerms: true,
      },
      cookie,
    );
    expect(response.status).toBe(201);
    return cookie;
  };

  beforeAll(async () => {
    harness = await createTestHarness();
    await harness.db.insert(profession).values({
      id: PROFESSION_ID,
      nameEn: "General practitioner",
      nameFr: "Médecin généraliste",
      prefixHint: "Dr.",
    });
    ownerCookie = await register("resource-owner@example.com", "Owner");
    otherCookie = await register("resource-other@example.com", "Other");
    patientCookie = await harness.signUpAndVerify(
      "resource-patient@example.com",
      "password12345",
      "Resource Patient",
    );
  });

  afterAll(() => harness.dispose());

  it("lists qualifications with metadata and validates create input", async () => {
    const invalid = await request("POST", "/v1/practitioners/me/qualifications", ownerCookie, {
      kind: "degree",
      title: "",
      institution: "University",
      country: "CM",
      year: 2018,
    });
    expect(invalid.status).toBe(422);

    const created = await request("POST", "/v1/practitioners/me/qualifications", ownerCookie, {
      id: QUALIFICATION_ID,
      kind: "degree",
      title: "Doctor of Medicine",
      institution: "University of Buea",
      country: "CM",
      year: 2018,
    });
    expect(created.status).toBe(201);

    const list = await request("GET", "/v1/practitioners/me/qualifications", ownerCookie);
    expect(list.status).toBe(200);
    expect(await json<ListBody>(list)).toMatchObject({
      data: [{ id: QUALIFICATION_ID }],
      meta: { count: 1, limit: 1, nextCursor: null, hasNextPage: false },
    });
  });

  it("rejects duplicate qualification IDs and enforces the twenty-item limit", async () => {
    const duplicate = await request("POST", "/v1/practitioners/me/qualifications", ownerCookie, {
      id: QUALIFICATION_ID,
      kind: "certification",
      title: "Duplicate ID",
      institution: "Institution",
      country: "CM",
      year: 2020,
    });
    expect(duplicate.status).toBe(409);

    const createRemaining = async (index: number): Promise<void> => {
      if (index >= 19) return;
      const response = await request("POST", "/v1/practitioners/me/qualifications", ownerCookie, {
        kind: "certification",
        title: `Certification ${index}`,
        institution: "Institution",
        country: "CM",
        year: 2020,
        sortOrder: index + 1,
      });
      expect(response.status).toBe(201);
      await createRemaining(index + 1);
    };
    await createRemaining(0);
    expect(
      (
        await request("POST", "/v1/practitioners/me/qualifications", ownerCookie, {
          kind: "certification",
          title: "Twenty-first qualification",
          institution: "Institution",
          country: "CM",
          year: 2020,
        })
      ).status,
    ).toBe(409);
  });

  it("hides qualifications from other practitioners and returns 404 for unknown IDs", async () => {
    expect(
      (
        await request(
          "PATCH",
          `/v1/practitioners/me/qualifications/${QUALIFICATION_ID}`,
          otherCookie,
          { year: 2021 },
        )
      ).status,
    ).toBe(404);
    expect(
      (
        await request(
          "DELETE",
          `/v1/practitioners/me/qualifications/${QUALIFICATION_ID}`,
          otherCookie,
        )
      ).status,
    ).toBe(404);
    expect(
      (
        await request("PATCH", `/v1/practitioners/me/qualifications/${UNKNOWN_ID}`, ownerCookie, {
          year: 2021,
        })
      ).status,
    ).toBe(404);
  });

  it("lists locations and maintains exactly one selected primary location", async () => {
    const first = await request("POST", "/v1/practitioners/me/locations", ownerCookie, {
      id: LOCATION_ID,
      label: "Hospital A",
      addressLine1: "Molyko",
      city: "Buea",
      region: "Southwest",
      consultationTypes: ["in_person"],
      isPrimary: true,
    });
    expect(first.status).toBe(201);
    const second = await request("POST", "/v1/practitioners/me/locations", ownerCookie, {
      label: "Hospital B",
      addressLine1: "Mile 17",
      city: "Buea",
      region: "Southwest",
      consultationTypes: ["in_person", "home_visit"],
      isPrimary: true,
    });
    expect(second.status).toBe(201);

    const listResponse = await request("GET", "/v1/practitioners/me/locations", ownerCookie);
    expect(listResponse.status).toBe(200);
    const list = await json<{
      readonly data: ReadonlyArray<{ readonly id: string; readonly isPrimary: boolean }>;
      readonly meta: ListBody["meta"];
    }>(listResponse);
    expect(list.meta).toEqual({ count: 2, limit: 2, nextCursor: null, hasNextPage: false });
    expect(list.data.filter((location) => location.isPrimary)).toHaveLength(1);
    expect(list.data.find((location) => location.id === LOCATION_ID)?.isPrimary).toBe(false);
  });

  it("validates locations, rejects duplicate IDs, and enforces the five-item limit", async () => {
    expect(
      (
        await request("POST", "/v1/practitioners/me/locations", ownerCookie, {
          label: "Invalid",
          addressLine1: "Address",
          city: "Buea",
          region: "Southwest",
          country: "Cameroon",
          consultationTypes: ["in_person"],
        })
      ).status,
    ).toBe(422);
    expect(
      (
        await request("POST", "/v1/practitioners/me/locations", ownerCookie, {
          id: LOCATION_ID,
          label: "Duplicate",
          addressLine1: "Address",
          city: "Buea",
          region: "Southwest",
          consultationTypes: ["in_person"],
        })
      ).status,
    ).toBe(409);

    const createRemaining = async (index: number): Promise<void> => {
      if (index >= 3) return;
      const response = await request("POST", "/v1/practitioners/me/locations", ownerCookie, {
        label: `Clinic ${index}`,
        addressLine1: `Street ${index}`,
        city: "Buea",
        region: "Southwest",
        consultationTypes: ["in_person"],
      });
      expect(response.status).toBe(201);
      await createRemaining(index + 1);
    };
    await createRemaining(0);
    expect(
      (
        await request("POST", "/v1/practitioners/me/locations", ownerCookie, {
          label: "Sixth clinic",
          addressLine1: "Street 6",
          city: "Buea",
          region: "Southwest",
          consultationTypes: ["in_person"],
        })
      ).status,
    ).toBe(409);
  });

  it("owner-scopes location updates and deletes", async () => {
    expect(
      (
        await request("PATCH", `/v1/practitioners/me/locations/${LOCATION_ID}`, otherCookie, {
          label: "Stolen",
        })
      ).status,
    ).toBe(404);
    expect(
      (await request("DELETE", `/v1/practitioners/me/locations/${LOCATION_ID}`, otherCookie))
        .status,
    ).toBe(404);
    expect(
      (
        await request("PATCH", `/v1/practitioners/me/locations/${UNKNOWN_ID}`, ownerCookie, {
          label: "Unknown",
        })
      ).status,
    ).toBe(404);
  });

  it("lists offerings and rejects duplicate type-duration pairs and IDs", async () => {
    expect(
      (
        await request("POST", "/v1/practitioners/me/offerings", ownerCookie, {
          consultationType: "video",
          durationMin: 0,
          priceXaf: -1,
        })
      ).status,
    ).toBe(422);
    const created = await request("POST", "/v1/practitioners/me/offerings", ownerCookie, {
      id: OFFERING_ID,
      consultationType: "video",
      durationMin: 30,
      priceXaf: 12_000,
    });
    expect(created.status).toBe(201);

    const list = await request("GET", "/v1/practitioners/me/offerings", ownerCookie);
    expect(list.status).toBe(200);
    expect(await json<ListBody>(list)).toMatchObject({
      data: [{ id: OFFERING_ID }],
      meta: { count: 1, limit: 1, nextCursor: null, hasNextPage: false },
    });

    expect(
      (
        await request("POST", "/v1/practitioners/me/offerings", ownerCookie, {
          consultationType: "video",
          durationMin: 30,
          priceXaf: 15_000,
        })
      ).status,
    ).toBe(409);
    expect(
      (
        await request("POST", "/v1/practitioners/me/offerings", ownerCookie, {
          id: OFFERING_ID,
          consultationType: "video",
          durationMin: 45,
          priceXaf: 15_000,
        })
      ).status,
    ).toBe(409);
  });

  it("owner-scopes offering mutations and rejects duplicate tuples on update", async () => {
    const secondResponse = await request("POST", "/v1/practitioners/me/offerings", ownerCookie, {
      consultationType: "in_person",
      durationMin: 45,
      priceXaf: 18_000,
    });
    const secondId = (await json<{ readonly id: string }>(secondResponse)).id;
    expect(
      (
        await request("PATCH", `/v1/practitioners/me/offerings/${secondId}`, ownerCookie, {
          consultationType: "video",
          durationMin: 30,
        })
      ).status,
    ).toBe(409);
    expect(
      (
        await request("PATCH", `/v1/practitioners/me/offerings/${OFFERING_ID}`, otherCookie, {
          priceXaf: 1,
        })
      ).status,
    ).toBe(404);
    expect(
      (await request("DELETE", `/v1/practitioners/me/offerings/${OFFERING_ID}`, otherCookie))
        .status,
    ).toBe(404);
    expect(
      (
        await request("PATCH", `/v1/practitioners/me/offerings/${UNKNOWN_ID}`, ownerCookie, {
          priceXaf: 1,
        })
      ).status,
    ).toBe(404);
  });

  it("lists only masked payout data and moves the default selection", async () => {
    const first = await request("POST", "/v1/practitioners/me/payout-methods", ownerCookie, {
      id: PAYOUT_ID,
      kind: "mtn_momo",
      accountName: "Resource Owner",
      accountNumber: "237670111222",
      isDefault: true,
    });
    expect(first.status).toBe(201);
    const second = await request("POST", "/v1/practitioners/me/payout-methods", ownerCookie, {
      kind: "orange_money",
      accountName: "Resource Owner",
      accountNumber: "237690333444",
      isDefault: true,
    });
    expect(second.status).toBe(201);
    secondPayoutId = (await json<{ readonly id: string }>(second)).id;

    const listResponse = await request("GET", "/v1/practitioners/me/payout-methods", ownerCookie);
    expect(listResponse.status).toBe(200);
    const list = await json<{
      readonly data: ReadonlyArray<{
        readonly id: string;
        readonly maskedAccountNumber: string;
        readonly isDefault: boolean;
      }>;
      readonly meta: ListBody["meta"];
    }>(listResponse);
    expect(list.meta).toEqual({ count: 2, limit: 2, nextCursor: null, hasNextPage: false });
    expect(list.data.filter((method) => method.isDefault)).toHaveLength(1);
    expect(list.data.find((method) => method.id === PAYOUT_ID)?.isDefault).toBe(false);
    expect(JSON.stringify(list)).not.toContain("237670111222");
    expect(JSON.stringify(list)).not.toContain("237690333444");
  });

  it("rejects duplicate payout accounts and client IDs", async () => {
    expect(
      (
        await request("POST", "/v1/practitioners/me/payout-methods", ownerCookie, {
          kind: "mtn_momo",
          accountName: "X",
          accountNumber: "123",
        })
      ).status,
    ).toBe(422);
    expect(
      (
        await request("POST", "/v1/practitioners/me/payout-methods", ownerCookie, {
          kind: "mtn_momo",
          accountName: "Resource Owner",
          accountNumber: "237670111222",
        })
      ).status,
    ).toBe(409);
    expect(
      (
        await request("POST", "/v1/practitioners/me/payout-methods", ownerCookie, {
          id: PAYOUT_ID,
          kind: "bank",
          accountName: "Resource Owner",
          accountNumber: "1234567890",
          bankName: "Test Bank",
        })
      ).status,
    ).toBe(409);
  });

  it("re-encrypts changed payout accounts and rejects duplicate-account updates", async () => {
    expect(
      (
        await request(
          "PATCH",
          `/v1/practitioners/me/payout-methods/${secondPayoutId}`,
          ownerCookie,
          { accountNumber: "237670111222" },
        )
      ).status,
    ).toBe(409);
    const updated = await request(
      "PATCH",
      `/v1/practitioners/me/payout-methods/${PAYOUT_ID}`,
      ownerCookie,
      { accountNumber: "237650999888" },
    );
    expect(updated.status).toBe(200);
    expect(await json<unknown>(updated)).toMatchObject({ maskedAccountNumber: "••••888" });
    expect(
      JSON.stringify(
        await json<unknown>(
          await request("GET", "/v1/practitioners/me/payout-methods", ownerCookie),
        ),
      ),
    ).not.toContain("237650999888");
  });

  it("owner-scopes payout mutations and returns 404 for unknown IDs", async () => {
    expect(
      (
        await request("PATCH", `/v1/practitioners/me/payout-methods/${PAYOUT_ID}`, otherCookie, {
          accountName: "Stolen",
        })
      ).status,
    ).toBe(404);
    expect(
      (await request("DELETE", `/v1/practitioners/me/payout-methods/${PAYOUT_ID}`, otherCookie))
        .status,
    ).toBe(404);
    expect(
      (
        await request("PATCH", `/v1/practitioners/me/payout-methods/${UNKNOWN_ID}`, ownerCookie, {
          accountName: "Unknown",
        })
      ).status,
    ).toBe(404);
  });

  it.each([
    "/v1/practitioners/me/qualifications",
    "/v1/practitioners/me/locations",
    "/v1/practitioners/me/offerings",
    "/v1/practitioners/me/payout-methods",
    "/v1/practitioners/me/earnings-terms",
  ])("requires authentication for GET %s", async (path) => {
    expect((await request("GET", path, undefined)).status).toBe(401);
  });

  it.each([
    "/v1/practitioners/me/qualifications",
    "/v1/practitioners/me/locations",
    "/v1/practitioners/me/offerings",
    "/v1/practitioners/me/payout-methods",
  ])("returns 404 for GET %s when the caller has no practitioner profile", async (path) => {
    expect((await request("GET", path, patientCookie)).status).toBe(404);
  });
});
