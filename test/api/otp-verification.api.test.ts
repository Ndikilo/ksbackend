import { eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { verification } from "@/db/schema/auth";
import { createTestHarness, type TestHarness } from "../support/app-harness";

// Safety-critical OTP verification paths (better-auth emailOTP): expiry is
// honored, and wrong attempts decrement a 3-try budget (the plugin default)
// before the code dies. Harness rate limiter is off — these tests re-request
// OTPs freely; the send budget itself is covered in account.api.test.ts.
describe("OTP verification safety (real DB)", () => {
  let harness: TestHarness;

  const requestReset = async (email: string): Promise<number> =>
    (await harness.post("/api/auth/email-otp/request-password-reset", { email })).status;

  const tryReset = async (email: string, otp: string, password: string): Promise<Response> =>
    harness.post("/api/auth/email-otp/reset-password", { email, otp, password });

  beforeAll(async () => {
    harness = await createTestHarness();
  });

  afterAll(() => harness.dispose());

  it("rejects an expired OTP — the reset cannot go through with a stale code", async () => {
    const email = "otp-expired@example.com";
    await harness.signUpAndVerify(email, "password12345", "Expi Red");
    expect(await requestReset(email)).toBe(200);
    const otp = harness.otpFor(email);

    // Age the verification record past its 5-minute expiry in the store.
    await harness.db
      .update(verification)
      .set({ expiresAt: sql`now() - interval '1 second'` })
      .where(eq(verification.identifier, email));

    const stale = await tryReset(email, otp, "attacker-password-1");
    expect(stale.status).not.toBe(200);
    // The old password still signs in — nothing was reset.
    expect(
      (await harness.post("/api/auth/sign-in/email", { email, password: "password12345" })).status,
    ).toBe(200);

    // A freshly requested code works.
    expect(await requestReset(email)).toBe(200);
    expect((await tryReset(email, harness.otpFor(email), "new-password-456")).status).toBe(200);
  });

  it("a single wrong attempt does not invalidate the code", async () => {
    const email = "otp-onewrong@example.com";
    await harness.signUpAndVerify(email, "password12345", "One Wrong");
    expect(await requestReset(email)).toBe(200);
    const otp = harness.otpFor(email);

    expect((await tryReset(email, "000000", "new-password-456")).status).not.toBe(200);
    expect((await tryReset(email, otp, "new-password-456")).status).toBe(200);
  });

  it("wrong OTP decrements attempts — the code is dead after 3 wrong tries", async () => {
    const email = "otp-attempts@example.com";
    await harness.signUpAndVerify(email, "password12345", "Attem Pts");
    expect(await requestReset(email)).toBe(200);
    const otp = harness.otpFor(email);

    // Three sequential wrong attempts (attempt counting is a read-modify-write
    // on the verification row, so the tries must not race each other).
    const wrong1 = await tryReset(email, "000000", "attacker-password-2");
    const wrong2 = await tryReset(email, "000000", "attacker-password-2");
    const wrong3 = await tryReset(email, "000000", "attacker-password-2");
    expect([wrong1.status, wrong2.status, wrong3.status].every((s) => s !== 200)).toBe(true);

    // Budget exhausted — even the CORRECT code is now rejected...
    expect((await tryReset(email, otp, "new-password-456")).status).not.toBe(200);
    // ...the account is not compromised (old password still works)...
    expect(
      (await harness.post("/api/auth/sign-in/email", { email, password: "password12345" })).status,
    ).toBe(200);
    // ...and a freshly requested code restores a working reset flow.
    expect(await requestReset(email)).toBe(200);
    expect((await tryReset(email, harness.otpFor(email), "new-password-456")).status).toBe(200);
  });
});
