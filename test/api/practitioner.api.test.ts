import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { profession } from "@/db/schema/profession";
import { createTestHarness, type TestHarness } from "../support/app-harness";

// SAFETY: API tests call endpoints with known response contracts and immediately assert on those shapes.
const json = <T>(res: Response): Promise<T> => res.json() as Promise<T>;
const PROFESSION_ID = "00000000-0000-4000-8000-000000000009";

const register = (harness: TestHarness, cookie: string) =>
  harness.post(
    "/v1/practitioners/register",
    {
      role: "doctor",
      professionId: PROFESSION_ID,
      surname: "Smith",
      givenNames: "Jane",
      consentVersion: "1.0",
      acceptTerms: true,
    },
    cookie,
  );

const credentials = (ownerId: string, over: Record<string, string> = {}) => ({
  cmcRegistrationNumber: "CMC-100001",
  nicNumber: "NIC-200001",
  cmcCertificateFileKey: `practitioner-documents/${ownerId}/cmc`,
  nicFileKey: `practitioner-documents/${ownerId}/nic`,
  profilePhotoFileKey: `profile-photos/${ownerId}/photo`,
  ...over,
});

// Practitioner endpoints (ours): presign, credential submission (+ scan reject,
// + licence dedupe), and profile fetch.
describe("practitioner API (real DB)", () => {
  let harness: TestHarness;
  let docCookie: string;
  let doctorUserId: string;

  beforeAll(async () => {
    harness = await createTestHarness();
    await harness.db
      .insert(profession)
      .values({ id: PROFESSION_ID, nameEn: "Doctor", nameFr: "Médecin", prefixHint: "Dr." });
    docCookie = await harness.signUpAndVerify("jane@example.com", "password12345", "Jane Smith");
    doctorUserId = await harness.userIdFor("jane@example.com");
    expect((await register(harness, docCookie)).status).toBe(201);
  });

  afterAll(() => harness.dispose());

  it("presign returns a URL for an allowed content type", async () => {
    const res = await harness.post(
      "/v1/practitioners/me/documents/presign",
      { kind: "cmc-certificate", contentType: "application/pdf" },
      docCookie,
    );
    expect(res.status).toBe(200);
    const body = await json<{ url: string; key: string }>(res);
    expect(body.key).toContain("practitioner-documents/");
    expect(body.url).toBeTruthy();
  });

  it("presign rejects an unsupported content type with 422", async () => {
    const res = await harness.post(
      "/v1/practitioners/me/documents/presign",
      { kind: "profile-photo", contentType: "image/gif" },
      docCookie,
    );
    expect(res.status).toBe(422);
    expect((await json<{ error: { code: string } }>(res)).error.code).toBe("VALIDATION_FAILED");
  });

  it("rejects credential file keys owned by another user", async () => {
    const res = await harness.post(
      "/v1/practitioners/me/credentials",
      credentials(doctorUserId, {
        cmcCertificateFileKey: "practitioner-documents/someone-else/cmc",
      }),
      docCookie,
    );
    expect(res.status).toBe(422);
    expect((await json<{ error: { code: string } }>(res)).error.code).toBe("VALIDATION_FAILED");
  });

  it("rejects credentials whose file failed the malware scan with 422 FILE_INFECTED", async () => {
    const res = await harness.post(
      "/v1/practitioners/me/credentials",
      credentials(doctorUserId, {
        nicFileKey: `practitioner-documents/${doctorUserId}/infected-nic`,
      }),
      docCookie,
    );
    expect(res.status).toBe(422);
    expect((await json<{ error: { code: string } }>(res)).error.code).toBe("FILE_INFECTED");
  });

  it("accepts clean credentials and moves to pending_verification", async () => {
    const res = await harness.post(
      "/v1/practitioners/me/credentials",
      credentials(doctorUserId),
      docCookie,
    );
    expect(res.status).toBe(200);
    expect((await json<{ verificationStatus: string }>(res)).verificationStatus).toBe(
      "pending_verification",
    );
  });

  it("rejects unknown language codes and profile photos owned by another user", async () => {
    const unknownLanguage = await harness.app.request("/v1/practitioners/me", {
      method: "PATCH",
      headers: { cookie: docCookie, "content-type": "application/json" },
      body: JSON.stringify({ languagesSpoken: ["zz"] }),
    });
    expect(unknownLanguage.status).toBe(422);

    const foreignPhoto = await harness.app.request("/v1/practitioners/me", {
      method: "PATCH",
      headers: { cookie: docCookie, "content-type": "application/json" },
      body: JSON.stringify({ profilePhotoFileKey: "profile-photos/someone-else/photo" }),
    });
    expect(foreignPhoto.status).toBe(422);
  });

  it("rejects a duplicate licence number from another account with 409", async () => {
    const otherCookie = await harness.signUpAndVerify(
      "mark@example.com",
      "password12345",
      "Mark Roe",
    );
    expect((await register(harness, otherCookie)).status).toBe(201);
    const otherUserId = await harness.userIdFor("mark@example.com");
    const res = await harness.post(
      "/v1/practitioners/me/credentials",
      credentials(otherUserId),
      otherCookie,
    );
    expect(res.status).toBe(409);
    expect((await json<{ error: { code: string } }>(res)).error.code).toBe(
      "LICENCE_ALREADY_REGISTERED",
    );
  });

  it("GET /v1/practitioners/me returns the profile; a non-practitioner gets 404", async () => {
    expect(
      (await harness.app.request("/v1/practitioners/me", { headers: { cookie: docCookie } }))
        .status,
    ).toBe(200);
    const patientCookie = await harness.signUpAndVerify(
      "pat@example.com",
      "password12345",
      "Pat P",
    );
    expect(
      (await harness.app.request("/v1/practitioners/me", { headers: { cookie: patientCookie } }))
        .status,
    ).toBe(404);
  });
});
