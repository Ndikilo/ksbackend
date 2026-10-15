import { Cause, Effect, Exit, ManagedRuntime } from "effect";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { AppRuntime } from "@/http/app-env";
import { createApp } from "@/http/app";
import { makeAuth } from "@/infra/auth";
import { makeConsoleClient } from "@/infra/email";
import { fakeInfra, makeAppLayer } from "@/runtime";
import { Health } from "@/infra/health";
import { testAuthSecret } from "../support/app-harness";
import { TestDatabaseLive } from "../support/testcontainers";

// Full-stack readiness: the real app layer (Health backed by a real Postgres via
// Testcontainers) through the actual /readyz endpoint.
describe("readyz (integration)", () => {
  let runtime: AppRuntime;
  let auth: ReturnType<typeof makeAuth>;
  let app: ReturnType<typeof createApp>;

  beforeAll(() => {
    runtime = ManagedRuntime.make(makeAppLayer(TestDatabaseLive, fakeInfra));
    auth = makeAuth({
      databaseUrl: "postgres://user:pass@localhost:5432/db",
      secret: testAuthSecret("health"),
      baseURL: "http://localhost:3000",
      defaultLocale: "fr",
      emailClient: makeConsoleClient(),
    });
    app = createApp(runtime, auth.instance);
  });

  afterAll(async () => {
    await runtime.dispose();
    await auth.close();
  });

  it("returns 200 once the real database answers (polls the readiness probe)", async () => {
    // First-use pool acquisition can take seconds on a cold container (the
    // CI run saw a 2.7s 503) — the probe's contract is 503-until-ready, so
    // poll within a bounded window instead of a single shot.
    const deadline = Date.now() + 30_000;
    let res = await app.request("/readyz");
    while (res.status !== 200 && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 500));
      res = await app.request("/readyz");
    }
    if (res.status !== 200) {
      // Surface WHY the probe never turned ready (layer build vs query).
      const exit = await runtime.runPromiseExit(Effect.flatMap(Health, (health) => health.ready));
      console.log(
        "DEBUG readyz failure — health exit:",
        Exit.isSuccess(exit) ? String(exit.value) : Cause.pretty(exit.cause),
      );
    }
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: "ok" });
    void Health;
  });
});
