import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTestHarness, type TestHarness } from "../support/app-harness";

type Pref = { category: string; email: boolean; sms: boolean; push: boolean };
// SAFETY: API tests call endpoints with known response contracts and immediately assert on those shapes.
const json = <T>(res: Response): Promise<T> => res.json() as Promise<T>;

// Notification preferences: per channel (email/sms/push) × category, with defaults
// filled for categories the user hasn't customised.
describe("notification preferences API (real DB)", () => {
  let harness: TestHarness;
  let cookie: string;

  beforeAll(async () => {
    harness = await createTestHarness();
    cookie = await harness.signUpAndVerify("notify@example.com", "password12345", "Note Ify");
  });

  afterAll(() => harness.dispose());

  it("returns all categories with defaults when nothing is customised", async () => {
    const res = await harness.app.request("/v1/me/notifications", { headers: { cookie } });
    expect(res.status).toBe(200);
    const body = await json<{ preferences: ReadonlyArray<Pref> }>(res);
    expect(body.preferences.map((p) => p.category).sort()).toEqual([
      "account",
      "appointments",
      "security",
      "verification",
    ]);
    // Defaults: email on, sms/push off.
    expect(body.preferences.every((p) => p.email && !p.sms && !p.push)).toBe(true);
  });

  it("PATCH updates one category per channel and persists it", async () => {
    const patched = await harness.app.request("/v1/me/notifications", {
      method: "PATCH",
      headers: { "content-type": "application/json", cookie },
      body: JSON.stringify({
        preferences: [{ category: "appointments", email: false, sms: true, push: true }],
      }),
    });
    expect(patched.status).toBe(200);
    const updated = (await json<{ preferences: ReadonlyArray<Pref> }>(patched)).preferences.find(
      (p) => p.category === "appointments",
    );
    expect(updated).toEqual({ category: "appointments", email: false, sms: true, push: true });

    // Re-read reflects the change; other categories keep defaults.
    const reread = await json<{ preferences: ReadonlyArray<Pref> }>(
      await harness.app.request("/v1/me/notifications", { headers: { cookie } }),
    );
    expect(reread.preferences.find((p) => p.category === "appointments")?.sms).toBe(true);
    expect(reread.preferences.find((p) => p.category === "security")?.email).toBe(true);
  });

  it("401s when unauthenticated", async () => {
    expect((await harness.app.request("/v1/me/notifications")).status).toBe(401);
  });
});
