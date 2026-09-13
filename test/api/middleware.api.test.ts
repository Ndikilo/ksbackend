import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTestHarness, type TestHarness } from "../support/app-harness";

const errorCode = async (res: Response): Promise<string> =>
  // SAFETY: middleware tests only call endpoints expected to return the standard error envelope.
  (await (res.json() as Promise<{ error: { code: string } }>)).error.code;

// Cross-cutting middleware wiring. Rate limit is set to 2/window via config so it
// trips deterministically. The other checks short-circuit BEFORE the rate limiter
// (body-limit / CORS preflight) or are exempt (health), so they don't consume budget.
describe("middleware wiring (real DB)", () => {
  let harness: TestHarness;

  beforeAll(async () => {
    harness = await createTestHarness({ RATE_LIMIT_MAX: "2", RATE_LIMIT_WINDOW_SECONDS: "60" });
  });

  afterAll(() => harness.dispose());

  it("rejects a body over the 1 MB limit with 413 PAYLOAD_TOO_LARGE", async () => {
    const res = await harness.post("/v1/patients/me/profile", { blob: "x".repeat(1_100_000) });
    expect(res.status).toBe(413);
    expect(await errorCode(res)).toBe("PAYLOAD_TOO_LARGE");
  });

  it("answers a CORS preflight with the configured origin", async () => {
    const res = await harness.app.request("/v1/patients/me/profile", {
      method: "OPTIONS",
      headers: {
        Origin: "http://localhost:3000",
        "Access-Control-Request-Method": "POST",
      },
    });
    expect([200, 204]).toContain(res.status);
    expect(res.headers.get("access-control-allow-origin")).toBe("http://localhost:3000");
    expect(res.headers.get("access-control-allow-credentials")).toBe("true");
  });

  it("sets security headers and never rate-limits health probes", async () => {
    const res = await harness.app.request("/livez");
    expect(res.status).toBe(200);
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
  });

  it("returns 429 with Retry-After once the rate limit is exceeded", async () => {
    const hit = () => harness.app.request("/openapi.json");
    expect((await hit()).status).toBe(200);
    expect((await hit()).status).toBe(200);
    const limited = await hit();
    expect(limited.status).toBe(429);
    expect(limited.headers.get("retry-after")).toBeTruthy();
    expect(await errorCode(limited)).toBe("RATE_LIMITED");
  });
});
