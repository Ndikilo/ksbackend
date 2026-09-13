import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { inArray } from "drizzle-orm";
import { user } from "@/db/schema/auth";
import { profession } from "@/db/schema/profession";
import { practitionerProfile } from "@/db/schema/practitioner-profile";
import { review } from "@/db/schema/review";
import { createTestHarness, type TestHarness } from "../support/app-harness";

// SAFETY: API tests call endpoints with known response contracts and assert on those shapes.
const json = <T>(res: Response): Promise<T> => res.json() as Promise<T>;
type JsonValue =
  | string
  | number
  | boolean
  | null
  | { readonly [k: string]: JsonValue }
  | ReadonlyArray<JsonValue>;
const PROFESSION_ID = "00000000-0000-4000-8000-000000000071";
const UNKNOWN_ID = "00000000-0000-4000-8000-0000000000ff";

describe("review API (real DB)", () => {
  let harness: TestHarness;
  let adminCookie: string;
  let patientA: string;
  let patientB: string;
  let doctorId: string;

  const post = async (path: string, body: JsonValue, cookie: string): Promise<Response> =>
    harness.app.request(path, {
      method: "POST",
      headers: { "content-type": "application/json", cookie },
      body: JSON.stringify(body),
    });

  const rating = async (
    cookie: string,
  ): Promise<{ ratingAverage: number; ratingCount: number }> => {
    const body = await json<{ ratingAverage: number; ratingCount: number }>(
      await harness.app.request(`/v1/practitioners/${doctorId}`, { headers: { cookie } }),
    );
    return { ratingAverage: body.ratingAverage, ratingCount: body.ratingCount };
  };

  const makePatient = async (email: string, surname: string): Promise<string> => {
    const cookie = await harness.signUpAndVerify(email, "password12345", surname);
    await harness.post(
      "/v1/patients/me/profile",
      {
        surname,
        givenNames: surname,
        dateOfBirth: "1990-01-01",
        sex: "female",
        consentVersion: "1.0",
        acceptTerms: true,
      },
      cookie,
    );
    return cookie;
  };

  beforeAll(async () => {
    harness = await createTestHarness();
    await harness.db
      .insert(profession)
      .values({ id: PROFESSION_ID, nameEn: "Doctor", nameFr: "Médecin", prefixHint: "Dr." });

    adminCookie = await harness.signUpAndVerify("rev-admin@example.com", "password12345", "Ad");
    await harness.promoteToAdmin("rev-admin@example.com");

    const docCookie = await harness.signUpAndVerify("rev-doc@example.com", "password12345", "Doc");
    const doctorUserId = await harness.userIdFor("rev-doc@example.com");
    doctorId = (
      await json<{ id: string }>(
        await post(
          "/v1/practitioners/register",
          {
            role: "doctor",
            professionId: PROFESSION_ID,
            surname: "Nkemtaji",
            givenNames: "Emmanuel",
            consentVersion: "1.0",
            acceptTerms: true,
          },
          docCookie,
        ),
      )
    ).id;
    await post(
      "/v1/practitioners/me/credentials",
      {
        cmcRegistrationNumber: "CMC-REV",
        nicNumber: "NIC-REV",
        cmcCertificateFileKey: `practitioner-documents/${doctorUserId}/cmc`,
        nicFileKey: `practitioner-documents/${doctorUserId}/nic`,
        profilePhotoFileKey: `profile-photos/${doctorUserId}/photo`,
      },
      docCookie,
    );
    await post(`/v1/admin/verifications/${doctorId}/approve`, {}, adminCookie);

    patientA = await makePatient("rev-pat-a@example.com", "Abena");
    patientB = await makePatient("rev-pat-b@example.com", "Bello");
    const reviewers = await harness.db
      .select({ id: user.id, email: user.email })
      .from(user)
      .where(inArray(user.email, ["rev-pat-a@example.com", "rev-pat-b@example.com"]));
    const reviewerA = reviewers.find((item) => item.email === "rev-pat-a@example.com")?.id;
    const reviewerB = reviewers.find((item) => item.email === "rev-pat-b@example.com")?.id;
    if (reviewerA === undefined || reviewerB === undefined) throw new Error("reviewer seed failed");
    await harness.db.insert(review).values([
      {
        id: "20000000-0000-4000-8000-000000000001",
        practitionerProfileId: doctorId,
        reviewerUserId: reviewerA,
        rating: 2,
        comment: "Helpful",
        createdAt: new Date("2026-08-01T10:00:00.000Z"),
        updatedAt: new Date("2026-08-01T10:00:00.000Z"),
      },
      {
        id: "20000000-0000-4000-8000-000000000002",
        practitionerProfileId: doctorId,
        reviewerUserId: reviewerB,
        rating: 4,
        comment: "Thorough",
        createdAt: new Date("2026-08-02T10:00:00.000Z"),
        updatedAt: new Date("2026-08-02T10:00:00.000Z"),
      },
    ]);
    await harness.db
      .update(practitionerProfile)
      .set({ ratingAverage: 3, ratingCount: 2 })
      .where(inArray(practitionerProfile.id, [doctorId]));
  });

  afterAll(() => harness.dispose());

  it("rejects reviews until a completed appointment exists", async () => {
    const res = await post(
      `/v1/practitioners/${doctorId}/reviews`,
      { rating: 4, comment: "Good" },
      patientA,
    );
    expect(res.status).toBe(403);
    expect(await json<{ error: { code: string } }>(res)).toMatchObject({
      error: { code: "REVIEW_NOT_ELIGIBLE" },
    });
    expect(await rating(patientA)).toEqual({ ratingAverage: 3, ratingCount: 2 });
  });

  it("returns the aggregate and rating distribution", async () => {
    const res = await harness.app.request(`/v1/practitioners/${doctorId}/reviews/summary`, {
      headers: { cookie: patientB },
    });
    expect(res.status).toBe(200);
    expect(await json<unknown>(res)).toEqual({
      average: 3,
      count: 2,
      distribution: { 1: 0, 2: 1, 3: 0, 4: 1, 5: 0 },
    });
  });

  it("lists reviews (paginated) with the reviewer's name", async () => {
    const res = await harness.app.request(`/v1/practitioners/${doctorId}/reviews`, {
      headers: { cookie: patientA },
    });
    expect(res.status).toBe(200);
    const body = await json<{
      data: ReadonlyArray<{ rating: number; reviewerName: string | null }>;
      meta: { count: number };
    }>(res);
    expect(body.meta.count).toBe(2);
    expect(body.data.map((r) => r.reviewerName).toSorted()).toEqual(["Abena A.", "Bello B."]);
  });

  it("filters reviews by rating and returns my review", async () => {
    const filtered = await json<{ data: ReadonlyArray<{ rating: number }> }>(
      await harness.app.request(`/v1/practitioners/${doctorId}/reviews?rating=4&sort=highest`, {
        headers: { cookie: patientA },
      }),
    );
    expect(filtered.data.map((item) => item.rating)).toEqual([4]);
    const mine = await harness.app.request(`/v1/practitioners/${doctorId}/reviews/me`, {
      headers: { cookie: patientA },
    });
    expect(mine.status).toBe(200);
    expect(await json<{ rating: number }>(mine)).toMatchObject({ rating: 2 });
  });

  it("paginates highest and lowest sorts with the complete sort tuple", async () => {
    const ratingsFor = async (sort: "highest" | "lowest"): Promise<ReadonlyArray<number>> => {
      const first = await json<{
        data: ReadonlyArray<{ rating: number }>;
        meta: { nextCursor: string | null };
      }>(
        await harness.app.request(`/v1/practitioners/${doctorId}/reviews?sort=${sort}&limit=1`, {
          headers: { cookie: patientA },
        }),
      );
      expect(first.meta.nextCursor).not.toBeNull();
      const second = await json<{ data: ReadonlyArray<{ rating: number }> }>(
        await harness.app.request(
          `/v1/practitioners/${doctorId}/reviews?sort=${sort}&limit=1&cursor=${first.meta.nextCursor ?? ""}`,
          { headers: { cookie: patientA } },
        ),
      );
      return [...first.data, ...second.data].map((item) => item.rating);
    };

    expect(await ratingsFor("highest")).toEqual([4, 2]);
    expect(await ratingsFor("lowest")).toEqual([2, 4]);
  });

  it("rejects malformed cursors and requires authentication for review reads", async () => {
    expect(
      (
        await harness.app.request(`/v1/practitioners/${doctorId}/reviews?cursor=not-a-cursor`, {
          headers: { cookie: patientA },
        })
      ).status,
    ).toBe(422);
    const paths = [
      `/v1/practitioners/${doctorId}/reviews`,
      `/v1/practitioners/${doctorId}/reviews/me`,
      `/v1/practitioners/${doctorId}/reviews/summary`,
    ];
    expect(
      await Promise.all(paths.map(async (path) => (await harness.app.request(path)).status)),
    ).toEqual([401, 401, 401]);
  });

  it("rejects a caller without the patient role (403)", async () => {
    // The admin's role was replaced with `admin` on promotion, so it lacks `patient`
    // (every ordinary signed-up user defaults to the patient role).
    const res = await post(`/v1/practitioners/${doctorId}/reviews`, { rating: 5 }, adminCookie);
    expect(res.status).toBe(403);
  });

  it("404s an unknown practitioner", async () => {
    const res = await post(`/v1/practitioners/${UNKNOWN_ID}/reviews`, { rating: 5 }, patientA);
    expect(res.status).toBe(404);
  });

  it("422s a rating out of range", async () => {
    const res = await post(`/v1/practitioners/${doctorId}/reviews`, { rating: 6 }, patientA);
    expect(res.status).toBe(422);
  });

  it("deletes the caller's own review (204) and recomputes the aggregate", async () => {
    const res = await harness.app.request(`/v1/practitioners/${doctorId}/reviews/me`, {
      method: "DELETE",
      headers: { cookie: patientA },
    });
    expect(res.status).toBe(204);
    // Only patientB's rating of 4 remains.
    expect(await rating(patientA)).toEqual({ ratingAverage: 4, ratingCount: 1 });

    const again = await harness.app.request(`/v1/practitioners/${doctorId}/reviews/me`, {
      method: "DELETE",
      headers: { cookie: patientA },
    });
    expect(again.status).toBe(404);
  });
});
