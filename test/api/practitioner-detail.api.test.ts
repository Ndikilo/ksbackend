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

const PROFESSION_ID = "00000000-0000-4000-8000-000000000091";
const CLIENT_QUALIFICATION_ID = "0198e3f0-0000-7000-8000-000000000101";
const CLIENT_LOCATION_ID = "0198e3f0-0000-7000-8000-000000000102";
const CLIENT_OFFERING_ID = "0198e3f0-0000-7000-8000-000000000103";
const CLIENT_PAYOUT_ID = "0198e3f0-0000-7000-8000-000000000104";
const CLIENT_EXCEPTION_ID = "0198e3f0-0000-7000-8000-000000000105";
const localFuture = new Date(Date.now() + 7 * 86_400_000 + 3_600_000);
const FUTURE_DATE = localFuture.toISOString().slice(0, 10);
const FUTURE_MONTH = FUTURE_DATE.slice(0, 7);
const jsWeekday = new Date(Date.parse(`${FUTURE_DATE}T00:00:00.000Z`)).getUTCDay();
const FUTURE_WEEKDAY = jsWeekday;
const RANGE_FROM = new Date(Date.parse(`${FUTURE_DATE}T00:00:00.000Z`) - 3_600_000).toISOString();
const RANGE_TO = new Date(Date.parse(`${FUTURE_DATE}T23:59:59.000Z`) - 3_600_000).toISOString();

describe("practitioner detail modules (real DB)", () => {
  let harness: TestHarness;
  let doctorCookie: string;
  let patientCookie: string;
  let doctorId: string;
  let qualificationId: string;
  let locationId: string;
  let offeringId: string;
  let payoutId: string;
  let exceptionId: string;

  const request = async (
    method: string,
    path: string,
    cookie: string,
    body?: JsonValue,
  ): Promise<Response> =>
    await harness.app.request(path, {
      method,
      headers: body === undefined ? { cookie } : { cookie, "content-type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });

  beforeAll(async () => {
    harness = await createTestHarness({ PLATFORM_COMMISSION_BPS: "2000" });
    await harness.db.insert(profession).values({
      id: PROFESSION_ID,
      nameEn: "Dentist",
      nameFr: "Dentiste",
      prefixHint: "Dr.",
    });
    const adminCookie = await harness.signUpAndVerify(
      "detail-admin@example.com",
      "password12345",
      "Admin",
    );
    await harness.promoteToAdmin("detail-admin@example.com");
    doctorCookie = await harness.signUpAndVerify(
      "detail-doctor@example.com",
      "password12345",
      "Doctor",
    );
    const doctorUserId = await harness.userIdFor("detail-doctor@example.com");
    doctorId = await harness
      .post(
        "/v1/practitioners/register",
        {
          role: "doctor",
          professionId: PROFESSION_ID,
          prefix: "Dr.",
          surname: "Mbah",
          givenNames: "Roland",
          consultationTypes: ["in_person", "video"],
          consentVersion: "1.0",
          acceptTerms: true,
        },
        doctorCookie,
      )
      .then(json<{ id: string }>)
      .then((body) => body.id);
    await harness.post(
      "/v1/practitioners/me/credentials",
      {
        cmcRegistrationNumber: "CMC/DENT/NW/47219",
        nicNumber: "DETAIL-NIC-001",
        cmcCertificateFileKey: `practitioner-documents/${doctorUserId}/cmc`,
        nicFileKey: `practitioner-documents/${doctorUserId}/nic`,
        profilePhotoFileKey: `profile-photos/${doctorUserId}/photo`,
      },
      doctorCookie,
    );
    await harness.post(`/v1/admin/verifications/${doctorId}/approve`, {}, adminCookie);
    patientCookie = await harness.signUpAndVerify(
      "detail-patient@example.com",
      "password12345",
      "Patient",
    );
  });

  afterAll(() => harness.dispose());

  it("serves reference catalogs and updates the UI locale", async () => {
    const professions = await request("GET", "/v1/professions", patientCookie);
    expect(professions.status).toBe(200);
    expect(
      (await json<{ data: ReadonlyArray<{ nameEn: string }> }>(professions)).data,
    ).toContainEqual(expect.objectContaining({ nameEn: "Dentist" }));
    const languages = await request("GET", "/v1/languages", patientCookie);
    expect(languages.status).toBe(200);
    expect((await json<{ data: ReadonlyArray<{ code: string }> }>(languages)).data).toContainEqual(
      expect.objectContaining({ code: "en" }),
    );
    const locale = await request("PATCH", "/v1/me", doctorCookie, { locale: "fr" });
    expect(locale.status).toBe(200);
    expect(await json<unknown>(locale)).toEqual({ locale: "fr" });
  });

  it("creates and edits qualifications and structured practice locations", async () => {
    const qualification = await request(
      "POST",
      "/v1/practitioners/me/qualifications",
      doctorCookie,
      {
        id: CLIENT_QUALIFICATION_ID,
        kind: "degree",
        title: "Doctor of Dental Surgery",
        institution: "University of Bamenda",
        country: "CM",
        year: 2015,
        sortOrder: 0,
      },
    );
    expect(qualification.status).toBe(201);
    qualificationId = (await json<{ id: string }>(qualification)).id;
    expect(qualificationId).toBe(CLIENT_QUALIFICATION_ID);
    const updated = await request(
      "PATCH",
      `/v1/practitioners/me/qualifications/${qualificationId}`,
      doctorCookie,
      {
        year: 2016,
      },
    );
    expect(updated.status).toBe(200);
    expect(await json<{ year: number }>(updated)).toMatchObject({ year: 2016 });

    const location = await request("POST", "/v1/practitioners/me/locations", doctorCookie, {
      id: CLIENT_LOCATION_ID,
      label: "General Hospital",
      addressLine1: "Mankon",
      city: "Bamenda",
      region: "Northwest",
      country: "CM",
      consultationTypes: ["in_person"],
      isPrimary: true,
    });
    expect(location.status).toBe(201);
    const locationBody = await json<{ id: string; latitude: number | null; isPrimary: boolean }>(
      location,
    );
    locationId = locationBody.id;
    expect(locationId).toBe(CLIENT_LOCATION_ID);
    expect(locationBody.isPrimary).toBe(true);
    expect(locationBody.latitude).not.toBeNull();
  });

  it("manages public offerings and encrypted, masked payout methods", async () => {
    const offering = await request("POST", "/v1/practitioners/me/offerings", doctorCookie, {
      id: CLIENT_OFFERING_ID,
      consultationType: "in_person",
      durationMin: 30,
      priceXaf: 10_000,
      active: true,
    });
    expect(offering.status).toBe(201);
    offeringId = (await json<{ id: string }>(offering)).id;
    expect(offeringId).toBe(CLIENT_OFFERING_ID);
    const terms = await request("GET", "/v1/practitioners/me/earnings-terms", doctorCookie);
    expect(await json<unknown>(terms)).toEqual({ commissionBps: 2000, commissionPercent: 20 });

    const payout = await request("POST", "/v1/practitioners/me/payout-methods", doctorCookie, {
      id: CLIENT_PAYOUT_ID,
      kind: "mtn_momo",
      accountName: "Roland Mbah",
      accountNumber: "237670123789",
      isDefault: true,
    });
    expect(payout.status).toBe(201);
    const payoutBody = await json<{ id: string; maskedAccountNumber: string }>(payout);
    payoutId = payoutBody.id;
    expect(payoutId).toBe(CLIENT_PAYOUT_ID);
    expect(payoutBody.maskedAccountNumber).toBe("••••789");
    expect(JSON.stringify(payoutBody)).not.toContain("237670123789");
  });

  it("publishes recurring availability, exceptions, and calendar days", async () => {
    const rules = await request("PUT", "/v1/practitioners/me/availability/rules", doctorCookie, {
      rules: [
        {
          weekday: FUTURE_WEEKDAY,
          startTime: "09:00",
          endTime: "11:00",
          slotDurationMin: 30,
          consultationTypes: ["in_person"],
          locationId,
          timezone: "Africa/Douala",
          validFrom: FUTURE_DATE,
          validTo: FUTURE_DATE,
        },
      ],
    });
    expect(rules.status).toBe(200);
    const blocked = await request(
      "POST",
      "/v1/practitioners/me/availability/exceptions",
      doctorCookie,
      {
        id: CLIENT_EXCEPTION_ID,
        date: FUTURE_DATE,
        kind: "blocked",
        startTime: "09:00",
        endTime: "09:30",
        consultationTypes: null,
        locationId: null,
      },
    );
    expect(blocked.status).toBe(201);
    exceptionId = (await json<{ id: string }>(blocked)).id;
    expect(exceptionId).toBe(CLIENT_EXCEPTION_ID);
    const range = await request(
      "GET",
      `/v1/practitioners/${doctorId}/availability?from=${encodeURIComponent(RANGE_FROM)}&to=${encodeURIComponent(RANGE_TO)}`,
      patientCookie,
    );
    expect(range.status).toBe(200);
    const slots = await json<{
      data: ReadonlyArray<{ startsAt: string; locationId: string | null }>;
    }>(range);
    expect(slots.data).toHaveLength(3);
    expect(slots.data[0]?.startsAt).toBe(`${FUTURE_DATE}T08:30:00.000Z`);
    expect(slots.data.every((slot) => slot.locationId === locationId)).toBe(true);
    const days = await request(
      "GET",
      `/v1/practitioners/${doctorId}/availability/days?month=${FUTURE_MONTH}`,
      patientCookie,
    );
    expect((await json<{ data: ReadonlyArray<string> }>(days)).data).toContain(FUTURE_DATE);
  });

  it("composes the public detail and exposes verification without private payout data", async () => {
    const photoUpload = await harness.post(
      "/v1/practitioners/me/documents/presign",
      { kind: "profile-photo", contentType: "image/png" },
      doctorCookie,
    );
    const photoKey = (await json<{ key: string }>(photoUpload)).key;
    const profileUpdate = await request("PATCH", "/v1/practitioners/me", doctorCookie, {
      bio: "Dentist focused on preventive care.",
      specialty: "Dentistry",
      languagesSpoken: ["en", "fr"],
      profilePhotoFileKey: photoKey,
    });
    expect(profileUpdate.status).toBe(200);
    const verification = await request("GET", "/v1/practitioners/me/verification", doctorCookie);
    const verificationBody = await json<{
      status: string;
      submittedAt: string | null;
      documents: ReadonlyArray<{ kind: string; uploadedAt: string }>;
      latestDecision: { decision: string } | null;
    }>(verification);
    expect(verificationBody.status).toBe("verified");
    expect(verificationBody.submittedAt).not.toBeNull();
    expect(verificationBody.documents).toHaveLength(3);
    const photoUploadedAt = verificationBody.documents.find(
      (document) => document.kind === "profile-photo",
    )?.uploadedAt;
    expect(Date.parse(photoUploadedAt ?? "")).toBeGreaterThanOrEqual(
      Date.parse(verificationBody.submittedAt ?? ""),
    );
    expect(verificationBody.latestDecision?.decision).toBe("approved");

    const detail = await request("GET", `/v1/practitioners/${doctorId}`, patientCookie);
    expect(detail.status).toBe(200);
    expect(detail.headers.get("cache-control")).toBe("private, max-age=60");
    expect(detail.headers.get("etag")).toBeTruthy();
    const detailBody = await json<{
      profession: { nameEn: string };
      languages: ReadonlyArray<{ code: string }>;
      qualifications: ReadonlyArray<{ id: string }>;
      locations: ReadonlyArray<{ id: string }>;
      offerings: ReadonlyArray<{ id: string }>;
      verification: { registrationNumber: string };
      booking: { bookable: boolean };
    }>(detail);
    expect(detailBody.profession.nameEn).toBe("Dentist");
    expect(detailBody.languages.map((item) => item.code).toSorted()).toEqual(["en", "fr"]);
    expect(detailBody.qualifications).toContainEqual(
      expect.objectContaining({ id: qualificationId }),
    );
    expect(detailBody.locations).toContainEqual(expect.objectContaining({ id: locationId }));
    expect(detailBody.offerings).toContainEqual(expect.objectContaining({ id: offeringId }));
    expect(detailBody.verification.registrationNumber).toBe("CMC/DENT/NW/47219");
    expect(detailBody.booking.bookable).toBe(true);
    expect(JSON.stringify(detailBody)).not.toContain(payoutId);

    expect(
      (
        await request(
          "DELETE",
          `/v1/practitioners/me/availability/exceptions/${exceptionId}`,
          doctorCookie,
        )
      ).status,
    ).toBe(204);
  });

  it("owner-scopes update and soft-delete operations across detail modules", async () => {
    expect(
      (
        await request("PATCH", `/v1/practitioners/me/offerings/${offeringId}`, doctorCookie, {
          priceXaf: 12_000,
        })
      ).status,
    ).toBe(200);
    expect(
      (
        await request("PATCH", `/v1/practitioners/me/payout-methods/${payoutId}`, doctorCookie, {
          accountName: "Roland T. Mbah",
        })
      ).status,
    ).toBe(200);
    expect(
      (
        await request("PATCH", `/v1/practitioners/me/locations/${locationId}`, doctorCookie, {
          label: "General Hospital Mankon",
        })
      ).status,
    ).toBe(200);
    expect(
      (await request("DELETE", `/v1/practitioners/me/locations/${locationId}`, doctorCookie))
        .status,
    ).toBe(409);
    expect(
      (
        await request("PUT", "/v1/practitioners/me/availability/rules", doctorCookie, {
          rules: [],
        })
      ).status,
    ).toBe(200);

    const targets = [
      `/v1/practitioners/me/qualifications/${qualificationId}`,
      `/v1/practitioners/me/offerings/${offeringId}`,
      `/v1/practitioners/me/payout-methods/${payoutId}`,
      `/v1/practitioners/me/locations/${locationId}`,
    ];
    expect(
      await Promise.all(
        targets.map(async (target) => (await request("DELETE", target, doctorCookie)).status),
      ),
    ).toEqual([204, 204, 204, 204]);

    const detail = await json<{ location: string | null; locations: ReadonlyArray<unknown> }>(
      await request("GET", `/v1/practitioners/${doctorId}`, patientCookie),
    );
    expect(detail.location).toBeNull();
    expect(detail.locations).toEqual([]);
  });
});
