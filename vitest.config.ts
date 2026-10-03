import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";
// Coverage types live on the root "vitest" export, not "vitest/config".
import type { CoverageOptions } from "vitest";

// Non-secret defaults so Config-driven layers (Crypto, locale) build under tests
// (tests don't go through varlock). A .config.ts is exempt from `no-process-env`.
process.env.DATA_ENCRYPTION_KEY ??= "a2FuYXNhbnRlLWRldi1lbmNyeXB0aW9uLWtleS0zMmI=";
process.env.DATA_HMAC_KEY ??= "a2FuYXNhbnRlLWRldi1obWFjLWtleS0wMDAwMDAwMzI=";
process.env.DEFAULT_LOCALE ??= "fr";

/**
 * Three test projects (see docs/conventions.md → Testing):
 *   - `unit`        : fast, pure/service-level tests colocated with source as `*.test.ts`.
 *   - `api`         : call the ACTUAL Hono endpoints via `app.request()`,
 *                     under `test/api/**` as `*.api.test.ts`.
 *   - `integration` : exercise real infra (Postgres via Testcontainers),
 *                     under `test/integration/**` as `*.integration.test.ts`.
 *
 * `bun run test` runs unit + api; `bun run test:api` runs api alone; both boot
 * Postgres via Testcontainers, so they need Docker. Only `bun run test:unit` is
 * Docker-free. `bun run test:integration` runs the integration tier. CI runs all.
 */
// Vite does not read tsconfig `paths`, so mirror the "@/*" -> src/* alias here
// (keep in sync with tsconfig.json). With `projects`, the root `resolve` is NOT
// inherited, so each project sets it explicitly.
const resolve = { alias: { "@": fileURLToPath(new URL("./src", import.meta.url)) } };

// Coverage (P1.T5): v8 provider over `src/**`, aggregated across the unit +
// api projects. Report-ONLY phase — thresholds are DEFINED below but enforced
// only when COVERAGE_ENFORCE=1, so `bun run test:coverage` always produces a
// report while baselines settle. Flip the flag on in CI to make them blocking
// once the numbers are meaningful.
const coverage: CoverageOptions<"v8"> = {
  provider: "v8",
  reporter: ["text", "html", "lcov"],
  include: ["src/**/*.ts"],
  // Tests cover code, they are not covered by it; generated drizzle tables and
  // the better-auth CLI boundary carry no meaningful coverage.
  exclude: ["src/**/*.test.ts", "src/db/schema/**", "src/auth.ts"],
};
if (process.env.COVERAGE_ENFORCE === "1") {
  coverage.thresholds = { lines: 60, branches: 45, functions: 55, statements: 60 };
}

export default defineConfig({
  test: {
    coverage,
    projects: [
      {
        resolve,
        test: {
          name: "unit",
          environment: "node",
          include: ["src/**/*.test.ts"],
        },
      },
      {
        resolve,
        test: {
          name: "api",
          environment: "node",
          include: ["test/api/**/*.api.test.ts"],
          // Some API tests boot a Postgres container (Testcontainers) for the
          // real route -> service -> repo path, so allow headroom.
          testTimeout: 120_000,
          hookTimeout: 120_000,
        },
      },
      {
        resolve,
        test: {
          name: "integration",
          environment: "node",
          include: ["test/integration/**/*.integration.test.ts"],
          // Booting a Postgres container (first run pulls the image) needs headroom.
          testTimeout: 120_000,
          hookTimeout: 120_000,
        },
      },
    ],
  },
});
