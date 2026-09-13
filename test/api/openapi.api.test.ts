import { ManagedRuntime } from "effect";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { z } from "zod";
import type { AppRuntime } from "@/http/app-env";
import { createApp } from "@/http/app";
import { makeAuth } from "@/infra/auth";
import { makeConsoleClient } from "@/infra/email";
import { fakeInfra, makeAppLayer } from "@/runtime";
import { TestDatabaseLive } from "../support/testcontainers";

// Only the path -> method keys matter here; decode rather than cast the document.
const Specification = z.object({ paths: z.record(z.string(), z.record(z.string(), z.unknown())) });

// Hono spells parameters `:id`; OpenAPI spells them `{id}`.
const toOpenApiPath = (path: string): string => path.replace(/:([A-Za-z][A-Za-z0-9]*)/g, "{$1}");

/**
 * The OpenAPI document is the published contract, so every `/v1` route must appear
 * in it and nothing else may. Both lists are derived — the served one from Hono's
 * own router, the documented one from the generated spec — so this catches a route
 * registered with `app.get` instead of `app.openapi` (served but undocumented) and a
 * `createRoute` whose handler was never wired (documented but unserved). A test that
 * grepped the spec for a hand-written list of paths could catch neither.
 *
 * Only the router and the generator are exercised, so no database is needed: the
 * runtime layer is built lazily and `/openapi.json` never touches it.
 */
describe("OpenAPI route coverage", () => {
  let runtime: AppRuntime;
  let auth: ReturnType<typeof makeAuth>;
  let served: ReadonlyArray<string>;
  let documented: ReadonlyArray<string>;

  beforeAll(async () => {
    runtime = ManagedRuntime.make(makeAppLayer(TestDatabaseLive, fakeInfra));
    auth = makeAuth({
      databaseUrl: "postgres://user:pass@localhost:5432/db",
      secret: "test-secret-min-32-chars-0000000000",
      baseURL: "http://localhost:3000",
      defaultLocale: "en",
      emailClient: makeConsoleClient(),
    });
    const app = createApp(runtime, auth.instance);

    // `ALL` entries are middleware (CORS, rate limiting, …), not endpoints.
    served = [
      ...new Set(
        app.routes
          .filter((route) => route.method !== "ALL" && route.path.startsWith("/v1/"))
          .map((route) => `${route.method.toLowerCase()} ${toOpenApiPath(route.path)}`),
      ),
    ].toSorted();

    const response = await app.request("/openapi.json");
    expect(response.status).toBe(200);
    const specification = Specification.parse(await response.json());
    documented = Object.entries(specification.paths)
      .flatMap(([path, operations]) => Object.keys(operations).map((method) => `${method} ${path}`))
      .toSorted();
  });

  afterAll(async () => {
    await runtime.dispose();
    await auth.close();
  });

  it("documents every served /v1 route", () => {
    expect(served.filter((route) => !documented.includes(route))).toEqual([]);
  });

  it("serves every documented /v1 route", () => {
    expect(documented.filter((route) => !served.includes(route))).toEqual([]);
  });
});
