import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { language } from "@/db/schema/language";
import { profession } from "@/db/schema/profession";
import { createTestHarness, type TestHarness } from "../support/app-harness";

// SAFETY: API tests call endpoints with known response contracts and assert on those shapes.
const json = <T>(response: Response): Promise<T> => response.json() as Promise<T>;

type ReferencePage = {
  readonly data: ReadonlyArray<{ readonly id: string }>;
  readonly meta: {
    readonly count: number;
    readonly limit: number;
    readonly nextCursor: string | null;
    readonly hasNextPage: boolean;
  };
};

describe("reference catalogs and locale API (real DB)", () => {
  let harness: TestHarness;
  let cookie: string;

  beforeAll(async () => {
    harness = await createTestHarness();
    cookie = await harness.signUpAndVerify(
      "reference-reader@example.com",
      "password12345",
      "Reference Reader",
    );
    await harness.db.insert(profession).values([
      {
        id: "0198e3f0-1000-7000-8000-000000000001",
        nameEn: "Cardiologist",
        nameFr: "Cardiologue",
        prefixHint: "Dr.",
      },
      {
        id: "0198e3f0-1000-7000-8000-000000000002",
        nameEn: "Dentist",
        nameFr: "Dentiste",
        prefixHint: "Dr.",
      },
      {
        id: "0198e3f0-1000-7000-8000-000000000003",
        nameEn: "Inactive profession",
        nameFr: "Profession inactive",
        prefixHint: null,
        active: false,
      },
    ]);
    await harness.db.insert(language).values({
      id: "0198e3f0-1000-7000-8000-000000000004",
      code: "zz",
      nameEn: "Inactive language",
      nameFr: "Langue inactive",
      active: false,
    });
  });

  afterAll(() => harness.dispose());

  it.each(["/v1/professions", "/v1/languages"])(
    "paginates %s with an opaque cursor and complete metadata",
    async (path) => {
      const firstResponse = await harness.app.request(`${path}?limit=1`, {
        headers: { cookie },
      });
      expect(firstResponse.status).toBe(200);
      const first = await json<ReferencePage>(firstResponse);
      expect(first.data).toHaveLength(1);
      expect(first.meta).toMatchObject({ count: 1, limit: 1, hasNextPage: true });
      expect(first.meta.nextCursor).not.toBeNull();

      const secondResponse = await harness.app.request(
        `${path}?limit=1&cursor=${encodeURIComponent(first.meta.nextCursor ?? "")}`,
        { headers: { cookie } },
      );
      expect(secondResponse.status).toBe(200);
      const second = await json<ReferencePage>(secondResponse);
      expect(second.data).toHaveLength(1);
      expect(second.data[0]?.id).not.toBe(first.data[0]?.id);
    },
  );

  it("returns active references only", async () => {
    const professions = await json<{
      readonly data: ReadonlyArray<{ readonly nameEn: string }>;
    }>(await harness.app.request("/v1/professions?limit=100", { headers: { cookie } }));
    const languages = await json<{
      readonly data: ReadonlyArray<{ readonly code: string }>;
    }>(await harness.app.request("/v1/languages?limit=100", { headers: { cookie } }));
    expect(professions.data.map((item) => item.nameEn)).not.toContain("Inactive profession");
    expect(languages.data.map((item) => item.code)).not.toContain("zz");
  });

  it.each(["/v1/professions", "/v1/languages"])(
    "rejects malformed cursors for %s",
    async (path) => {
      expect(
        (
          await harness.app.request(`${path}?cursor=not-a-valid-cursor`, {
            headers: { cookie },
          })
        ).status,
      ).toBe(422);
    },
  );

  it.each(["/v1/professions", "/v1/languages"])("requires authentication for %s", async (path) => {
    expect((await harness.app.request(path)).status).toBe(401);
  });

  it("validates and authenticates locale updates", async () => {
    const valid = await harness.app.request("/v1/me", {
      method: "PATCH",
      headers: { cookie, "content-type": "application/json" },
      body: JSON.stringify({ locale: "fr" }),
    });
    expect(valid.status).toBe(200);
    expect(await json<unknown>(valid)).toEqual({ locale: "fr" });

    const invalid = await harness.app.request("/v1/me", {
      method: "PATCH",
      headers: { cookie, "content-type": "application/json" },
      body: JSON.stringify({ locale: "es" }),
    });
    expect(invalid.status).toBe(422);

    const unauthenticated = await harness.app.request("/v1/me", {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ locale: "fr" }),
    });
    expect(unauthenticated.status).toBe(401);
  });
});
