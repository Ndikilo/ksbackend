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

const PROFESSION_ID = "0198e3f0-3000-7000-8000-000000000001";
const EXCEPTION_ID = "0198e3f0-3000-7000-8000-000000000101";
const EXTRA_EXCEPTION_ID = "0198e3f0-3000-7000-8000-000000000102";
const UNKNOWN_ID = "0198e3f0-3000-7000-8000-000000000999";
const RULE_DATE = "2026-09-07";

describe("recurring availability API (real DB)", () => {
  let harness: TestHarness;
  let adminCookie: string;
  let doctorCookie: string;
  let otherDoctorCookie: string;
  let patientCookie: string;
  let doctorId: string;
  let unverifiedDoctorId: string;
  let foreignLocationId: string;

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

  const register = async (
    email: string,
  ): Promise<{ readonly cookie: string; readonly id: string }> => {
    const cookie = await harness.signUpAndVerify(email, "password12345", "Schedule Doctor");
    const response = await harness.post(
      "/v1/practitioners/register",
      {
        role: "doctor",
        professionId: PROFESSION_ID,
        surname: "Schedule",
        givenNames: "Doctor",
        consultationTypes: ["in_person", "video"],
        consentVersion: "1.0",
        acceptTerms: true,
      },
      cookie,
    );
    expect(response.status).toBe(201);
    return { cookie, id: (await json<{ readonly id: string }>(response)).id };
  };

  beforeAll(async () => {
    harness = await createTestHarness();
    await harness.db.insert(profession).values({
      id: PROFESSION_ID,
      nameEn: "Schedule specialist",
      nameFr: "Spécialiste des horaires",
      prefixHint: "Dr.",
    });
    adminCookie = await harness.signUpAndVerify(
      "schedule-admin@example.com",
      "password12345",
      "Schedule Admin",
    );
    await harness.promoteToAdmin("schedule-admin@example.com");
    const doctor = await register("schedule-doctor@example.com");
    doctorCookie = doctor.cookie;
    doctorId = doctor.id;
    const doctorUserId = await harness.userIdFor("schedule-doctor@example.com");
    await harness.post(
      "/v1/practitioners/me/credentials",
      {
        cmcRegistrationNumber: "CMC/SCHEDULE/001",
        nicNumber: "SCHEDULE-NIC-001",
        cmcCertificateFileKey: `practitioner-documents/${doctorUserId}/cmc`,
        nicFileKey: `practitioner-documents/${doctorUserId}/nic`,
        profilePhotoFileKey: `profile-photos/${doctorUserId}/photo`,
      },
      doctorCookie,
    );
    await harness.post(`/v1/admin/verifications/${doctorId}/approve`, {}, adminCookie);
    const other = await register("schedule-other@example.com");
    otherDoctorCookie = other.cookie;
    unverifiedDoctorId = other.id;
    foreignLocationId = (
      await json<{ readonly id: string }>(
        await harness.post(
          "/v1/practitioners/me/locations",
          {
            label: "Other clinic",
            addressLine1: "Other street",
            city: "Douala",
            region: "Littoral",
            consultationTypes: ["in_person"],
          },
          otherDoctorCookie,
        ),
      )
    ).id;
    patientCookie = await harness.signUpAndVerify(
      "schedule-patient@example.com",
      "password12345",
      "Schedule Patient",
    );
  });

  afterAll(() => harness.dispose());

  it("accepts and lists an overnight rule using JavaScript weekday numbering", async () => {
    const replaced = await request("PUT", "/v1/practitioners/me/availability/rules", doctorCookie, {
      rules: [
        {
          weekday: 1,
          startTime: "22:00",
          endTime: "02:00",
          slotDurationMin: 60,
          consultationTypes: ["video"],
          timezone: "Africa/Douala",
          validFrom: RULE_DATE,
          validTo: RULE_DATE,
        },
      ],
    });
    expect(replaced.status).toBe(200);

    const listed = await request("GET", "/v1/practitioners/me/availability/rules", doctorCookie);
    expect(listed.status).toBe(200);
    expect(
      await json<{
        readonly data: ReadonlyArray<{ readonly weekday: number; readonly endTime: string }>;
        readonly meta: { readonly count: number; readonly hasNextPage: boolean };
      }>(listed),
    ).toMatchObject({
      data: [{ weekday: 1, endTime: "02:00" }],
      meta: { count: 1, hasNextPage: false },
    });
  });

  it("expands overnight rules across midnight in the requested public window", async () => {
    const response = await request(
      "GET",
      `/v1/practitioners/${doctorId}/availability?from=2026-09-07T20%3A00%3A00.000Z&to=2026-09-08T02%3A00%3A00.000Z`,
      patientCookie,
    );
    expect(response.status).toBe(200);
    const body = await json<{
      readonly data: ReadonlyArray<{ readonly startsAt: string }>;
    }>(response);
    expect(body.data.map((slot) => slot.startsAt)).toEqual([
      "2026-09-07T21:00:00.000Z",
      "2026-09-07T22:00:00.000Z",
      "2026-09-07T23:00:00.000Z",
      "2026-09-08T00:00:00.000Z",
    ]);
  });

  it("rejects overlapping rules without replacing the saved schedule", async () => {
    const response = await request("PUT", "/v1/practitioners/me/availability/rules", doctorCookie, {
      rules: [
        {
          weekday: 1,
          startTime: "09:00",
          endTime: "11:00",
          slotDurationMin: 30,
          consultationTypes: ["in_person"],
        },
        {
          weekday: 1,
          startTime: "10:30",
          endTime: "12:00",
          slotDurationMin: 30,
          consultationTypes: ["video"],
        },
      ],
    });
    expect(response.status).toBe(422);
    const listed = await json<{ readonly data: ReadonlyArray<{ readonly startTime: string }> }>(
      await request("GET", "/v1/practitioners/me/availability/rules", doctorCookie),
    );
    expect(listed.data.map((rule) => rule.startTime)).toEqual(["22:00"]);
  });

  it.each([
    {
      rules: [
        {
          weekday: 1,
          startTime: "09:00",
          endTime: "09:00",
          slotDurationMin: 30,
          consultationTypes: ["video"],
        },
      ],
    },
    {
      rules: [
        {
          weekday: 7,
          startTime: "09:00",
          endTime: "10:00",
          slotDurationMin: 30,
          consultationTypes: ["video"],
        },
      ],
    },
    {
      rules: [
        {
          weekday: 1,
          startTime: "09:00",
          endTime: "10:00",
          slotDurationMin: 30,
          consultationTypes: ["video"],
          validFrom: "2026-10-01",
          validTo: "2026-09-01",
        },
      ],
    },
  ])("rejects invalid weekly schedules", async (body) => {
    expect(
      (await request("PUT", "/v1/practitioners/me/availability/rules", doctorCookie, body)).status,
    ).toBe(422);
  });

  it("validates exception shapes and rejects duplicate client IDs", async () => {
    expect(
      (
        await request("POST", "/v1/practitioners/me/availability/exceptions", doctorCookie, {
          date: RULE_DATE,
          kind: "extra",
        })
      ).status,
    ).toBe(422);
    expect(
      (
        await request("POST", "/v1/practitioners/me/availability/exceptions", doctorCookie, {
          date: RULE_DATE,
          kind: "blocked",
          startTime: "09:00",
        })
      ).status,
    ).toBe(422);

    const created = await request(
      "POST",
      "/v1/practitioners/me/availability/exceptions",
      doctorCookie,
      { id: EXCEPTION_ID, date: RULE_DATE, kind: "blocked" },
    );
    expect(created.status).toBe(201);
    expect(
      (
        await request("POST", "/v1/practitioners/me/availability/exceptions", doctorCookie, {
          id: EXCEPTION_ID,
          date: "2026-09-08",
          kind: "blocked",
        })
      ).status,
    ).toBe(409);
  });

  it("rejects rules and exceptions that reference another practitioner's location", async () => {
    expect(
      (
        await request("PUT", "/v1/practitioners/me/availability/rules", doctorCookie, {
          rules: [
            {
              weekday: 2,
              startTime: "09:00",
              endTime: "10:00",
              slotDurationMin: 30,
              consultationTypes: ["in_person"],
              locationId: foreignLocationId,
            },
          ],
        })
      ).status,
    ).toBe(422);
    expect(
      (
        await request("POST", "/v1/practitioners/me/availability/exceptions", doctorCookie, {
          date: "2026-09-08",
          kind: "extra",
          startTime: "10:00",
          endTime: "11:00",
          consultationTypes: ["in_person"],
          locationId: foreignLocationId,
        })
      ).status,
    ).toBe(422);
  });

  it("creates extra availability and serializes times to the declared HH:mm contract", async () => {
    const created = await request(
      "POST",
      "/v1/practitioners/me/availability/exceptions",
      doctorCookie,
      {
        id: EXTRA_EXCEPTION_ID,
        date: "2026-09-08",
        kind: "extra",
        startTime: "14:00",
        endTime: "15:00",
        consultationTypes: ["in_person"],
      },
    );
    expect(created.status).toBe(201);
    expect(await json<unknown>(created)).toMatchObject({
      id: EXTRA_EXCEPTION_ID,
      startTime: "14:00",
      endTime: "15:00",
    });

    const publicResponse = await request(
      "GET",
      `/v1/practitioners/${doctorId}/availability?from=2026-09-08T12%3A00%3A00.000Z&to=2026-09-08T15%3A00%3A00.000Z`,
      patientCookie,
    );
    expect(publicResponse.status).toBe(200);
    expect(
      (
        await json<{ readonly data: ReadonlyArray<{ readonly startsAt: string }> }>(publicResponse)
      ).data.map((slot) => slot.startsAt),
    ).toEqual(["2026-09-08T13:00:00.000Z"]);
  });

  it("owner-scopes exception deletion and returns 404 after deletion", async () => {
    expect(
      (
        await request(
          "DELETE",
          `/v1/practitioners/me/availability/exceptions/${EXCEPTION_ID}`,
          otherDoctorCookie,
        )
      ).status,
    ).toBe(404);
    expect(
      (
        await request(
          "DELETE",
          `/v1/practitioners/me/availability/exceptions/${EXCEPTION_ID}`,
          doctorCookie,
        )
      ).status,
    ).toBe(204);
    expect(
      (
        await request(
          "DELETE",
          `/v1/practitioners/me/availability/exceptions/${UNKNOWN_ID}`,
          doctorCookie,
        )
      ).status,
    ).toBe(404);
    expect(
      (
        await request(
          "DELETE",
          `/v1/practitioners/me/availability/exceptions/${EXTRA_EXCEPTION_ID}`,
          doctorCookie,
        )
      ).status,
    ).toBe(204);
  });

  it("applies the default fourteen-day window and rejects invalid ranges", async () => {
    const defaultWindow = await request(
      "GET",
      `/v1/practitioners/${doctorId}/availability`,
      patientCookie,
    );
    expect(defaultWindow.status).toBe(200);
    const meta = (
      await json<{ readonly meta: { readonly from: string; readonly to: string } }>(defaultWindow)
    ).meta;
    expect(Date.parse(meta.to) - Date.parse(meta.from)).toBe(14 * 86_400_000);

    expect(
      (
        await request(
          "GET",
          `/v1/practitioners/${doctorId}/availability?from=2026-09-01T00%3A00%3A00.000Z&to=2026-11-01T00%3A00%3A00.000Z`,
          patientCookie,
        )
      ).status,
    ).toBe(422);
    expect(
      (
        await request(
          "GET",
          `/v1/practitioners/${doctorId}/availability?from=2026-09-02T00%3A00%3A00.000Z&to=2026-09-01T00%3A00%3A00.000Z`,
          patientCookie,
        )
      ).status,
    ).toBe(422);
    expect(
      (
        await request(
          "GET",
          `/v1/practitioners/${doctorId}/availability?from=not-a-date`,
          patientCookie,
        )
      ).status,
    ).toBe(422);
  });

  it("validates calendar months and hides unverified practitioners", async () => {
    expect(
      (
        await request(
          "GET",
          `/v1/practitioners/${doctorId}/availability/days?month=2026-13`,
          patientCookie,
        )
      ).status,
    ).toBe(422);
    expect(
      (
        await request(
          "GET",
          `/v1/practitioners/${unverifiedDoctorId}/availability/days?month=2026-09`,
          patientCookie,
        )
      ).status,
    ).toBe(404);
  });

  it("enforces authentication and practitioner role boundaries", async () => {
    expect(
      (await request("GET", "/v1/practitioners/me/availability/rules", undefined)).status,
    ).toBe(401);
    expect(
      (await request("GET", "/v1/practitioners/me/availability/rules", patientCookie)).status,
    ).toBe(403);
    expect(
      (await request("GET", `/v1/practitioners/${doctorId}/availability`, undefined)).status,
    ).toBe(401);
  });
});
