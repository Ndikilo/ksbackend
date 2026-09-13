import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { patientProfile } from "@/db/schema/patient-profile";
import { user } from "@/db/schema/auth";
import { createTestHarness, type TestHarness } from "../support/app-harness";

// Account lifecycle via better-auth endpoints (wired with our emailOTP + hooks):
// password reset, email change, and account deletion (+ our data cascade).
describe("account lifecycle (real DB)", () => {
  let harness: TestHarness;

  beforeAll(async () => {
    harness = await createTestHarness();
  });

  afterAll(() => harness.dispose());

  it("password reset: request OTP -> reset -> sign in with the new password", async () => {
    const email = "reset@example.com";
    await harness.signUpAndVerify(email, "old-password-123", "Reset Me");

    expect(
      (await harness.post("/api/auth/email-otp/request-password-reset", { email })).status,
    ).toBe(200);
    const reset = await harness.post("/api/auth/email-otp/reset-password", {
      email,
      otp: harness.otpFor(email),
      password: "new-password-456",
    });
    expect(reset.status).toBe(200);

    // Old password no longer works; new password does.
    expect(
      (await harness.post("/api/auth/sign-in/email", { email, password: "old-password-123" }))
        .status,
    ).not.toBe(200);
    expect(
      (await harness.post("/api/auth/sign-in/email", { email, password: "new-password-456" }))
        .status,
    ).toBe(200);
  });

  it("email change: request OTP to the new address -> confirm -> email updated", async () => {
    const email = "change-from@example.com";
    const newEmail = "change-to@example.com";
    const cookie = await harness.signUpAndVerify(email, "password12345", "Change Me");

    const request = await harness.post(
      "/api/auth/email-otp/request-email-change",
      { newEmail },
      cookie,
    );
    expect([200, 201]).toContain(request.status);
    const confirm = await harness.post(
      "/api/auth/email-otp/change-email",
      { newEmail, otp: harness.otpFor(newEmail) },
      cookie,
    );
    expect(confirm.status).toBe(200);

    const rows = await harness.db
      .select({ email: user.email })
      .from(user)
      .where(eq(user.email, newEmail));
    expect(rows.length).toBe(1);
  });

  it("delete account: removes the user and cascades our profile rows", async () => {
    const email = "delete@example.com";
    const password = "password12345";
    const cookie = await harness.signUpAndVerify(email, password, "Del Ete");
    await harness.post(
      "/v1/patients/me/profile",
      {
        surname: "Ete",
        givenNames: "Del",
        dateOfBirth: "1988-01-01",
        sex: "female",
        consentVersion: "1.0",
        acceptTerms: true,
      },
      cookie,
    );

    const before = await harness.db.select({ id: user.id }).from(user).where(eq(user.email, email));
    const userId = before[0]?.id;
    expect(userId).toBeTruthy();

    const deleted = await harness.post("/api/auth/delete-user", { password }, cookie);
    expect([200, 204]).toContain(deleted.status);

    const users = await harness.db.select({ id: user.id }).from(user).where(eq(user.email, email));
    expect(users.length).toBe(0);
    const profiles = await harness.db
      .select({ userId: patientProfile.userId })
      .from(patientProfile)
      .where(eq(patientProfile.userId, userId ?? ""));
    expect(profiles.length).toBe(0);
  });

  it("change password: wrong current is rejected; correct rotates it and revokes other sessions", async () => {
    const email = "changepw@example.com";
    const cookieA = await harness.signUpAndVerify(email, "old-password-123", "Change Pw");
    // A second, concurrent session for the same user.
    const cookieB =
      (
        await harness.post("/api/auth/sign-in/email", { email, password: "old-password-123" })
      ).headers.get("set-cookie") ?? "";
    expect((await harness.app.request("/v1/me", { headers: { cookie: cookieB } })).status).toBe(
      200,
    );

    // Wrong current password is refused.
    expect(
      (
        await harness.post(
          "/api/auth/change-password",
          { currentPassword: "not-the-password", newPassword: "brand-new-789" },
          cookieA,
        )
      ).status,
    ).not.toBe(200);

    // Correct current password rotates it and (revokeOtherSessions) kills session B.
    expect(
      [200, 201].includes(
        (
          await harness.post(
            "/api/auth/change-password",
            {
              currentPassword: "old-password-123",
              newPassword: "brand-new-789",
              revokeOtherSessions: true,
            },
            cookieA,
          )
        ).status,
      ),
    ).toBe(true);

    // Old password no longer signs in; the other session is dead; the new one works.
    expect(
      (await harness.post("/api/auth/sign-in/email", { email, password: "old-password-123" }))
        .status,
    ).not.toBe(200);
    expect((await harness.app.request("/v1/me", { headers: { cookie: cookieB } })).status).toBe(
      401,
    );
    expect(
      (await harness.post("/api/auth/sign-in/email", { email, password: "brand-new-789" })).status,
    ).toBe(200);
  });

  it("password reset revokes all other sessions", async () => {
    const email = "reset-revoke@example.com";
    await harness.signUpAndVerify(email, "old-password-123", "Reset Revoke");
    const staleCookie =
      (
        await harness.post("/api/auth/sign-in/email", { email, password: "old-password-123" })
      ).headers.get("set-cookie") ?? "";
    expect((await harness.app.request("/v1/me", { headers: { cookie: staleCookie } })).status).toBe(
      200,
    );

    expect(
      (await harness.post("/api/auth/email-otp/request-password-reset", { email })).status,
    ).toBe(200);
    expect(
      (
        await harness.post("/api/auth/email-otp/reset-password", {
          email,
          otp: harness.otpFor(email),
          password: "new-password-456",
        })
      ).status,
    ).toBe(200);

    // The session that existed before the reset is now invalid.
    expect((await harness.app.request("/v1/me", { headers: { cookie: staleCookie } })).status).toBe(
      401,
    );
  });
});

// The OTP *send* endpoints carry a strict per-IP budget (3 / 15 min). This harness
// forces better-auth's rate limiter on so the 4th send in the window is refused.
describe("OTP send rate budget (real DB)", () => {
  let harness: TestHarness;

  beforeAll(async () => {
    harness = await createTestHarness(undefined, { rateLimit: { enabled: true } });
  });

  afterAll(() => harness.dispose());

  it("refuses a 4th password-reset OTP send within the window", async () => {
    const email = "budget@example.com";
    await harness.signUpAndVerify(email, "password12345", "Budget User");

    for (let i = 0; i < 3; i += 1) {
      expect(
        (await harness.post("/api/auth/email-otp/request-password-reset", { email })).status,
      ).toBe(200);
    }
    expect(
      (await harness.post("/api/auth/email-otp/request-password-reset", { email })).status,
    ).toBe(429);
  });
});
