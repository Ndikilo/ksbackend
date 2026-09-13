import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { profession } from "@/db/schema/profession";
import { createTestHarness, type TestHarness } from "../support/app-harness";

// SAFETY: API tests call endpoints with known response contracts and immediately assert on those shapes.
const json = <T>(res: Response): Promise<T> => res.json() as Promise<T>;
const PROFESSION_ID = "00000000-0000-4000-8000-000000000001";

// The full auth + registration journeys against a real Postgres, via the shared
// harness (which captures OTP and notification emails).
describe("registration flows (real DB)", () => {
  let harness: TestHarness;

  beforeAll(async () => {
    harness = await createTestHarness();
    await harness.db
      .insert(profession)
      .values({ id: PROFESSION_ID, nameEn: "Doctor", nameFr: "Médecin", prefixHint: "Dr." });
  });

  afterAll(() => harness.dispose());

  it("patient: sign up -> verify OTP -> complete & fetch profile", async () => {
    const cookie = await harness.signUpAndVerify(
      "patient@example.com",
      "password12345",
      "Pat Ient",
    );

    const created = await harness.post(
      "/v1/patients/me/profile",
      {
        surname: "Ient",
        givenNames: "Pat",
        dateOfBirth: "1990-05-01",
        sex: "male",
        consentVersion: "1.0",
        acceptTerms: true,
        emergencyContact: { name: "Kin Folk", phone: "+237650000001", relationship: "sister" },
      },
      cookie,
    );
    expect(created.status).toBe(200);
    const createdBody = await json<{ surname: string; emergencyContact: { name: string } | null }>(
      created,
    );
    expect(createdBody.surname).toBe("Ient");
    expect(createdBody.emergencyContact?.name).toBe("Kin Folk");

    expect(
      (await harness.app.request("/v1/patients/me/profile", { headers: { cookie } })).status,
    ).toBe(200);
    expect((await harness.app.request("/v1/patients/me/profile")).status).toBe(401);

    // Self-granting the patient role again must NOT wipe the emergency contact.
    expect(
      (await harness.app.request("/v1/me/roles/patient", { method: "POST", headers: { cookie } }))
        .status,
    ).toBe(204);
    const afterClaim = await json<{ emergencyContact: { name: string } | null }>(
      await harness.app.request("/v1/patients/me/profile", { headers: { cookie } }),
    );
    expect(afterClaim.emergencyContact?.name).toBe("Kin Folk");
  });

  it("multi-role: registering as practitioner preserves base fields set as a patient", async () => {
    const cookie = await harness.signUpAndVerify("both@example.com", "password12345", "Both Roles");
    // As a patient: set phone + DOB on the base profile.
    expect(
      (
        await harness.post(
          "/v1/patients/me/profile",
          {
            surname: "Both",
            givenNames: "Role",
            phone: "+237650000009",
            dateOfBirth: "1985-06-15",
            sex: "female",
            consentVersion: "1.0",
            acceptTerms: true,
          },
          cookie,
        )
      ).status,
    ).toBe(200);

    // Later register as a practitioner WITHOUT re-supplying phone/DOB.
    expect(
      (
        await harness.post(
          "/v1/practitioners/register",
          {
            role: "doctor",
            professionId: PROFESSION_ID,
            surname: "Both",
            givenNames: "Role",
            consentVersion: "1.0",
            acceptTerms: true,
          },
          cookie,
        )
      ).status,
    ).toBe(201);

    // The base profile must still carry the patient-set phone + DOB (not nulled).
    const base = await json<{ phone: string | null; dateOfBirth: string | null }>(
      await harness.app.request("/v1/me/profile", { headers: { cookie } }),
    );
    expect(base.phone).toBe("+237650000009");
    expect(base.dateOfBirth).toBe("1985-06-15");
  });

  it("practitioner: register -> submit credentials -> admin approves", async () => {
    const docCookie = await harness.signUpAndVerify(
      "doctor@example.com",
      "password12345",
      "Doc Tor",
    );
    const doctorUserId = await harness.userIdFor("doctor@example.com");

    const registered = await harness.post(
      "/v1/practitioners/register",
      {
        role: "doctor",
        professionId: PROFESSION_ID,
        surname: "Tor",
        givenNames: "Doc",
        consentVersion: "1.0",
        acceptTerms: true,
      },
      docCookie,
    );
    expect(registered.status).toBe(201);

    const submitted = await harness.post(
      "/v1/practitioners/me/credentials",
      {
        cmcRegistrationNumber: "CMC-123456",
        nicNumber: "NIC-778899",
        cmcCertificateFileKey: `practitioner-documents/${doctorUserId}/cmc`,
        nicFileKey: `practitioner-documents/${doctorUserId}/nic`,
        profilePhotoFileKey: `profile-photos/${doctorUserId}/photo`,
      },
      docCookie,
    );
    expect(submitted.status).toBe(200);
    const practitioner = await json<{ id: string; verificationStatus: string }>(submitted);
    expect(practitioner.verificationStatus).toBe("pending_verification");

    const adminCookie = await harness.signUpAndVerify(
      "admin@example.com",
      "password12345",
      "Ad Min",
    );
    await harness.promoteToAdmin("admin@example.com");

    const pending = await harness.app.request("/v1/admin/verifications?limit=10", {
      headers: { cookie: adminCookie },
    });
    expect(pending.status).toBe(200);
    const page = await json<{ data: ReadonlyArray<{ id: string }> }>(pending);
    expect(page.data.some((p) => p.id === practitioner.id)).toBe(true);

    // A non-admin cannot list verifications.
    expect(
      (await harness.app.request("/v1/admin/verifications", { headers: { cookie: docCookie } }))
        .status,
    ).toBe(403);

    const approved = await harness.post(
      `/v1/admin/verifications/${practitioner.id}/approve`,
      {},
      adminCookie,
    );
    expect(approved.status).toBe(200);
    expect((await json<{ verificationStatus: string }>(approved)).verificationStatus).toBe(
      "verified",
    );

    // The practitioner was emailed an approval notice.
    expect(
      harness.sent.some((m) => m.to === "doctor@example.com" && /verified/i.test(m.subject)),
    ).toBe(true);
  });
});
