import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { user } from "@/db/schema/auth";
import { createTestHarness, type TestHarness } from "../support/app-harness";

// SAFETY: API tests call endpoints with known response contracts and immediately assert on those shapes.
const json = <T>(res: Response): Promise<T> => res.json() as Promise<T>;

// Admin actions are gated on admin_profile scope; a bare `admin` role isn't enough.
// Also covers self-granting the patient role.
describe("admin scope + self-grant role (real DB)", () => {
  let harness: TestHarness;

  beforeAll(async () => {
    harness = await createTestHarness();
  });

  afterAll(() => harness.dispose());

  it("a verification_reviewer can list verifications", async () => {
    const cookie = await harness.signUpAndVerify("reviewer@example.com", "password12345", "Rev");
    await harness.promoteToAdmin("reviewer@example.com", "verification_reviewer");
    expect(
      (await harness.app.request("/v1/admin/verifications", { headers: { cookie } })).status,
    ).toBe(200);
  });

  it("an admin role WITHOUT an admin_profile scope is forbidden", async () => {
    const cookie = await harness.signUpAndVerify(
      "noscope@example.com",
      "password12345",
      "No Scope",
    );
    // Role set, but no admin_profile row → no scope.
    await harness.db
      .update(user)
      .set({ role: "admin" })
      .where(eq(user.email, "noscope@example.com"));
    expect(
      (await harness.app.request("/v1/admin/verifications", { headers: { cookie } })).status,
    ).toBe(403);
  });

  it("a user can self-grant the patient role", async () => {
    const cookie = await harness.signUpAndVerify(
      "claimer@example.com",
      "password12345",
      "Claim Er",
    );
    expect(
      (await harness.app.request("/v1/me/roles/patient", { method: "POST", headers: { cookie } }))
        .status,
    ).toBe(204);

    const me = await json<{ roles: ReadonlyArray<string> }>(
      await harness.app.request("/v1/me", { headers: { cookie } }),
    );
    expect(me.roles).toContain("patient");
  });
});
