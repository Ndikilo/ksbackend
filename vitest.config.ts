import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

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

export default defineConfig({
  test: {
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
