import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTestHarness, type TestHarness } from "../support/app-harness";

// SAFETY: API tests call endpoints with known response contracts and assert on those shapes.
const json = <T>(res: Response): Promise<T> => res.json() as Promise<T>;

type PatientCard = {
  readonly id: string;
  readonly surname: string;
  readonly givenNames: string;
};
type SearchBody = {
  readonly data: ReadonlyArray<PatientCard>;
  readonly meta: { readonly total: number; readonly page: number; readonly pageSize: number };
};

describe("patient search API (real DB)", () => {
  let harness: TestHarness;
  let adminCookie: string;
  let patientCookie: string;

  const makePatient = async (
    email: string,
    surname: string,
    givenNames: string,
  ): Promise<string> => {
    const cookie = await harness.signUpAndVerify(email, "password12345", givenNames);
    await harness.post(
      "/v1/patients/me/profile",
      {
        surname,
        givenNames,
        dateOfBirth: "1990-05-01",
        sex: "female",
        consentVersion: "1.0",
        acceptTerms: true,
        emergencyContact: { name: "Kin Folk", phone: "+237650000001", relationship: "sister" },
      },
      cookie,
    );
    return cookie;
  };

  beforeAll(async () => {
    harness = await createTestHarness();
    adminCookie = await harness.signUpAndVerify("psearch-admin@example.com", "password12345", "Ad");
    await harness.promoteToAdmin("psearch-admin@example.com");
    patientCookie = await makePatient("psearch-abena@example.com", "Abena", "Marie");
    await makePatient("psearch-tchoua@example.com", "Tchoua", "Paul");
  });

  afterAll(() => harness.dispose());

  it("lets an admin list patients with offset metadata and only non-sensitive fields", async () => {
    const res = await harness.app.request("/v1/patients", { headers: { cookie: adminCookie } });
    expect(res.status).toBe(200);
    const body = await json<SearchBody>(res);
    expect(body.meta.total).toBe(2);
    const card = body.data.find((p) => p.surname === "Abena");
    expect(card?.givenNames).toBe("Marie");
    // Sensitive fields must never leak into the card.
    expect(card).not.toHaveProperty("phone");
    expect(card).not.toHaveProperty("dateOfBirth");
    expect(card).not.toHaveProperty("emergencyContact");
    expect(card).not.toHaveProperty("sex");
  });

  it("fuzzy-matches the patient name via q", async () => {
    const res = await harness.app.request("/v1/patients?q=Abenna", {
      headers: { cookie: adminCookie },
    });
    const body = await json<SearchBody>(res);
    expect(body.data.map((p) => p.surname)).toEqual(["Abena"]);
  });

  it("forbids a non-admin caller (403)", async () => {
    const res = await harness.app.request("/v1/patients", { headers: { cookie: patientCookie } });
    expect(res.status).toBe(403);
    const body = await json<{ error: { code: string } }>(res);
    expect(body.error.code).toBe("FORBIDDEN");
  });

  it("requires a session", async () => {
    const res = await harness.app.request("/v1/patients");
    expect(res.status).toBe(401);
  });
});
