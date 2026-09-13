import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { profession } from "@/db/schema/profession";
import { createTestHarness, type TestHarness } from "../support/app-harness";

// SAFETY: API tests call endpoints with known response contracts and immediately assert on those shapes.
const json = <T>(res: Response): Promise<T> => res.json() as Promise<T>;
const code = async (res: Response): Promise<string> =>
  (await json<{ error: { code: string } }>(res)).error.code;
const PROFESSION_ID = "00000000-0000-4000-8000-000000000042";

const register = (harness: TestHarness, cookie: string) =>
  harness.post(
    "/v1/practitioners/register",
    {
      role: "doctor",
      professionId: PROFESSION_ID,
      surname: "Guard",
      givenNames: "State",
      consentVersion: "1.0",
      acceptTerms: true,
    },
    cookie,
  );

const credentials = (userId: string) => ({
  cmcRegistrationNumber: "CMC-900001",
  nicNumber: "NIC-900001",
  cmcCertificateFileKey: `practitioner-documents/${userId}/cmc`,
  nicFileKey: `practitioner-documents/${userId}/nic`,
  profilePhotoFileKey: `profile-photos/${userId}/photo`,
});

// The verification state machine must not be skippable: an admin can't approve a
// profile that never submitted credentials, and a verified practitioner can't
// silently resubmit to reset themselves to pending.
describe("verification state guards (real DB)", () => {
  let harness: TestHarness;
  let docCookie: string;
  let adminCookie: string;
  let practitionerId: string;
  let doctorUserId: string;

  beforeAll(async () => {
    harness = await createTestHarness();
    await harness.db
      .insert(profession)
      .values({ id: PROFESSION_ID, nameEn: "Doctor", nameFr: "Médecin", prefixHint: "Dr." });

    docCookie = await harness.signUpAndVerify(
      "guard-doc@example.com",
      "password12345",
      "State Guard",
    );
    doctorUserId = await harness.userIdFor("guard-doc@example.com");
    practitionerId = (await json<{ id: string }>(await register(harness, docCookie))).id;

    adminCookie = await harness.signUpAndVerify(
      "guard-admin@example.com",
      "password12345",
      "Ad Min",
    );
    await harness.promoteToAdmin("guard-admin@example.com");
  });

  afterAll(() => harness.dispose());

  it("rejects approving a profile that never submitted credentials (still incomplete)", async () => {
    const res = await harness.post(
      `/v1/admin/verifications/${practitionerId}/approve`,
      {},
      adminCookie,
    );
    expect(res.status).toBe(409);
    expect(await code(res)).toBe("VERIFICATION_STATE_INVALID");
  });

  it("blocks resubmission and re-decision once verified", async () => {
    // Complete the real flow: submit -> pending -> admin approves -> verified.
    expect(
      (await harness.post("/v1/practitioners/me/credentials", credentials(doctorUserId), docCookie))
        .status,
    ).toBe(200);
    expect(
      (await harness.post(`/v1/admin/verifications/${practitionerId}/approve`, {}, adminCookie))
        .status,
    ).toBe(200);

    // A verified practitioner cannot resubmit to reset themselves to pending.
    const resubmit = await harness.post(
      "/v1/practitioners/me/credentials",
      credentials(doctorUserId),
      docCookie,
    );
    expect(resubmit.status).toBe(409);
    expect(await code(resubmit)).toBe("VERIFICATION_STATE_INVALID");

    // And an already-verified profile can't be re-decided.
    const reapprove = await harness.post(
      `/v1/admin/verifications/${practitionerId}/approve`,
      {},
      adminCookie,
    );
    expect(reapprove.status).toBe(409);
    expect(await code(reapprove)).toBe("VERIFICATION_STATE_INVALID");
  });
});
