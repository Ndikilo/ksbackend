import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { profession } from "@/db/schema/profession";
import { createTestHarness, type TestHarness } from "../support/app-harness";

// SAFETY: API tests call endpoints with known response contracts and immediately assert on those shapes.
const json = <T>(res: Response): Promise<T> => res.json() as Promise<T>;
const PROFESSION_ID = "00000000-0000-4000-8000-000000000055";

// Registers and submits credentials, but stops short of admin approval.
const pendingPractitioner = async (harness: TestHarness, email: string): Promise<string> => {
  const cookie = await harness.signUpAndVerify(email, "password12345", "Doc Public");
  const userId = await harness.userIdFor(email);
  const id = (
    await json<{ id: string }>(
      await harness.post(
        "/v1/practitioners/register",
        {
          role: "doctor",
          professionId: PROFESSION_ID,
          surname: "Public",
          givenNames: "Doc",
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
      cmcRegistrationNumber: `CMC-${email}`,
      nicNumber: `NIC-${email}`,
      cmcCertificateFileKey: `practitioner-documents/${userId}/cmc`,
      nicFileKey: `practitioner-documents/${userId}/nic`,
      profilePhotoFileKey: `profile-photos/${userId}/photo`,
    },
    cookie,
  );
  return id;
};

describe("practitioner public profile API (real DB)", () => {
  let harness: TestHarness;
  let docCookie: string;
  let practitionerId: string;

  beforeAll(async () => {
    harness = await createTestHarness();
    await harness.db
      .insert(profession)
      .values({ id: PROFESSION_ID, nameEn: "Doctor", nameFr: "Médecin", prefixHint: "Dr." });

    docCookie = await harness.signUpAndVerify("pub-doc@example.com", "password12345", "Doc Pub");
    const doctorUserId = await harness.userIdFor("pub-doc@example.com");
    practitionerId = (
      await json<{ id: string }>(
        await harness.post(
          "/v1/practitioners/register",
          {
            role: "doctor",
            professionId: PROFESSION_ID,
            surname: "Pub",
            givenNames: "Doc",
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
        cmcRegistrationNumber: "CMC-PUB",
        nicNumber: "NIC-PUB",
        cmcCertificateFileKey: `practitioner-documents/${doctorUserId}/cmc`,
        nicFileKey: `practitioner-documents/${doctorUserId}/nic`,
        profilePhotoFileKey: `profile-photos/${doctorUserId}/photo`,
      },
      docCookie,
    );

    const adminCookie = await harness.signUpAndVerify(
      "pub-admin@example.com",
      "password12345",
      "Ad",
    );
    await harness.promoteToAdmin("pub-admin@example.com");
    await harness.post(`/v1/admin/verifications/${practitionerId}/approve`, {}, adminCookie);
  });

  afterAll(() => harness.dispose());

  it("lets a practitioner edit their public profile", async () => {
    const res = await harness.app.request("/v1/practitioners/me", {
      method: "PATCH",
      headers: { "content-type": "application/json", cookie: docCookie },
      body: JSON.stringify({
        specialty: "Cardiology",
        bio: "20 years of care.",
        languagesSpoken: ["fr", "en"],
        yearsExperience: 20,
        consultationFeeXaf: 15000,
      }),
    });
    expect(res.status).toBe(200);
    const body = await json<{ specialty: string; languagesSpoken: string[] }>(res);
    expect(body.specialty).toBe("Cardiology");
    expect(body.languagesSpoken).toEqual(["fr", "en"]);
  });

  it("exposes the public profile (no sensitive fields) to another user", async () => {
    const patientCookie = await harness.signUpAndVerify(
      "pub-pat@example.com",
      "password12345",
      "Pat",
    );
    const res = await harness.app.request(`/v1/practitioners/${practitionerId}`, {
      headers: { cookie: patientCookie },
    });
    expect(res.status).toBe(200);
    const body = await json<{
      readonly specialty?: string | null;
      readonly photoUrl?: string | null;
      readonly phone?: string | null;
      readonly dateOfBirth?: string | null;
      readonly sex?: string | null;
    }>(res);
    expect(body.specialty).toBe("Cardiology");
    expect(body.photoUrl).toBeTruthy();
    // Sensitive/private fields must NOT be in the public view.
    expect(body.phone).toBeUndefined();
    expect(body.dateOfBirth).toBeUndefined();
    expect(body.sex).toBeUndefined();
  });

  it("404s the public profile for a practitioner who isn't verified yet", async () => {
    const unverifiedId = await pendingPractitioner(harness, "pub-unverified@example.com");
    const patientCookie = await harness.signUpAndVerify(
      "pub-pat2@example.com",
      "password12345",
      "Pat2",
    );
    const res = await harness.app.request(`/v1/practitioners/${unverifiedId}`, {
      headers: { cookie: patientCookie },
    });
    expect(res.status).toBe(404);
  });
});
