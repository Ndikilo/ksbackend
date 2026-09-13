import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { profession } from "@/db/schema/profession";
import { createTestHarness, type TestHarness } from "../support/app-harness";

// SAFETY: API tests call endpoints with known response contracts and assert on those shapes.
const json = <T>(response: Response): Promise<T> => response.json() as Promise<T>;

const PROFESSION_ID = "0198e3f0-4000-7000-8000-000000000001";

type VerificationBody = {
  readonly status: "incomplete" | "pending_verification" | "verified" | "rejected";
  readonly submittedAt: string | null;
  readonly documents: ReadonlyArray<{ readonly kind: string; readonly uploadedAt: string }>;
  readonly latestDecision: {
    readonly decision: "approved" | "rejected";
    readonly reason: string | null;
  } | null;
  readonly canResubmit: boolean;
};

describe("practitioner verification status API (real DB)", () => {
  let harness: TestHarness;
  let adminCookie: string;
  let doctorCookie: string;
  let patientCookie: string;
  let doctorId: string;
  let doctorUserId: string;

  const verification = async (): Promise<Response> =>
    await harness.app.request("/v1/practitioners/me/verification", {
      headers: { cookie: doctorCookie },
    });

  beforeAll(async () => {
    harness = await createTestHarness();
    await harness.db.insert(profession).values({
      id: PROFESSION_ID,
      nameEn: "Verification specialist",
      nameFr: "Spécialiste de vérification",
      prefixHint: "Dr.",
    });
    adminCookie = await harness.signUpAndVerify(
      "verification-status-admin@example.com",
      "password12345",
      "Verification Admin",
    );
    await harness.promoteToAdmin("verification-status-admin@example.com");
    doctorCookie = await harness.signUpAndVerify(
      "verification-status-doctor@example.com",
      "password12345",
      "Verification Doctor",
    );
    doctorUserId = await harness.userIdFor("verification-status-doctor@example.com");
    const registered = await harness.post(
      "/v1/practitioners/register",
      {
        role: "doctor",
        professionId: PROFESSION_ID,
        surname: "Verification",
        givenNames: "Doctor",
        consentVersion: "1.0",
        acceptTerms: true,
      },
      doctorCookie,
    );
    doctorId = (await json<{ readonly id: string }>(registered)).id;
    patientCookie = await harness.signUpAndVerify(
      "verification-status-patient@example.com",
      "password12345",
      "Verification Patient",
    );
  });

  afterAll(() => harness.dispose());

  it("reports an incomplete profile with no fabricated submission or documents", async () => {
    const response = await verification();
    expect(response.status).toBe(200);
    expect(await json<VerificationBody>(response)).toEqual({
      status: "incomplete",
      submittedAt: null,
      documents: [],
      latestDecision: null,
      canResubmit: true,
    });
  });

  it("reports the pending submission and each owned document timestamp", async () => {
    const submitted = await harness.post(
      "/v1/practitioners/me/credentials",
      {
        cmcRegistrationNumber: "CMC/STATUS/001",
        nicNumber: "STATUS-NIC-001",
        cmcCertificateFileKey: `practitioner-documents/${doctorUserId}/cmc`,
        nicFileKey: `practitioner-documents/${doctorUserId}/nic`,
        profilePhotoFileKey: `profile-photos/${doctorUserId}/photo`,
      },
      doctorCookie,
    );
    expect(submitted.status).toBe(200);
    const response = await verification();
    expect(response.status).toBe(200);
    const body = await json<VerificationBody>(response);
    expect(body.status).toBe("pending_verification");
    expect(body.submittedAt).not.toBeNull();
    expect(body.documents.map((document) => document.kind).toSorted()).toEqual([
      "cmc-certificate",
      "nic",
      "profile-photo",
    ]);
    expect(body.documents.every((document) => Date.parse(document.uploadedAt) > 0)).toBe(true);
    expect(body.latestDecision).toBeNull();
    expect(body.canResubmit).toBe(false);
  });

  it("reports a rejection decision and permits resubmission", async () => {
    const rejected = await harness.post(
      `/v1/admin/verifications/${doctorId}/reject`,
      { reason: "Certificate image is unreadable." },
      adminCookie,
    );
    expect(rejected.status).toBe(200);
    const response = await verification();
    const body = await json<VerificationBody>(response);
    expect(body.status).toBe("rejected");
    expect(body.latestDecision).toEqual({
      decision: "rejected",
      reason: "Certificate image is unreadable.",
      createdAt: expect.any(String),
    });
    expect(body.canResubmit).toBe(true);

    const resubmitted = await harness.post(
      "/v1/practitioners/me/credentials",
      {
        cmcRegistrationNumber: "CMC/STATUS/001",
        nicNumber: "STATUS-NIC-001",
        cmcCertificateFileKey: `practitioner-documents/${doctorUserId}/cmc-retry`,
        nicFileKey: `practitioner-documents/${doctorUserId}/nic-retry`,
        profilePhotoFileKey: `profile-photos/${doctorUserId}/photo-retry`,
      },
      doctorCookie,
    );
    expect(resubmitted.status).toBe(200);
    const pendingAgain = await json<VerificationBody>(await verification());
    expect(pendingAgain.status).toBe("pending_verification");
    expect(pendingAgain.canResubmit).toBe(false);
  });

  it("returns 404 to a non-practitioner and 401 without a session", async () => {
    expect(
      (
        await harness.app.request("/v1/practitioners/me/verification", {
          headers: { cookie: patientCookie },
        })
      ).status,
    ).toBe(404);
    expect((await harness.app.request("/v1/practitioners/me/verification")).status).toBe(401);
  });
});
