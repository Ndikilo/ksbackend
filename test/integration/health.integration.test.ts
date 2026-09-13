import { ManagedRuntime } from "effect";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { AppRuntime } from "@/http/app-env";
import { createApp } from "@/http/app";
import { makeAuth } from "@/infra/auth";
import { makeConsoleClient } from "@/infra/email";
import { fakeInfra, makeAppLayer } from "@/runtime";
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
      secret: "test-secret-min-32-chars-0000000000",
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

  it("returns 200 when the real database is reachable", async () => {
    const res = await app.request("/readyz");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: "ok" });
  });
});
