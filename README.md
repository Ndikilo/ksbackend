# kanasante API

A Hono + TypeScript API, fully **Effect**-based, backed by **Postgres** via **Drizzle**.
Validated end-to-end with **Zod** (OpenAPI generated from the same schemas), auth via
**better-auth**, structured logging via **evlog**, env/secrets via **varlock**,
linted/formatted with **oxc** (oxlint + oxfmt), tested with **Vitest**, on **Bun**.

> **New here?** Read [`AGENTS.md`](./AGENTS.md) — the single source of truth for how this
> repo is built and the conventions everyone (humans **and** AI agents) must follow.

## Quickstart

Prerequisites: [Bun](https://bun.sh) ≥ 1.3, Docker, and the [AWS CLI](https://aws.amazon.com/cli/).

```bash
bun run setup   # install deps, create .env.local, start Postgres, validate env
bun run dev     # start the API
```

Local dev runs the **same real drivers as prod**, pointed at local emulators (Postgres via
Docker, S3 via LocalStack, email via a personal Resend account) — so there are no fakes to
drift from production. That needs a short one-time setup: **see [docs/local-dev.md](./docs/local-dev.md)**.

## Scripts

| Command                                            | What it does                                          |
| -------------------------------------------------- | ----------------------------------------------------- |
| `bun run setup`                                    | One-command bootstrap (idempotent)                    |
| `bun run infra:up` / `infra:down`                  | Start/stop local infra (Postgres + LocalStack S3)     |
| `bun run email:local`                              | Start resend-local (email dashboard at :8005)         |
| `bun run dev`                                      | Start the API with hot reload (via `varlock run`)     |
| `bun run start`                                    | Start the API without watch                           |
| `bun run test`                                     | Run **all** tests (unit + api)                        |
| `bun run test:unit`                                | Unit tests only                                       |
| `bun run test:api`                                 | API tests only (real endpoints via `app.request()`)   |
| `bun run test:watch`                               | Tests in watch mode                                   |
| `bun run lint` / `lint:fix`                        | oxlint                                                |
| `bun run format` / `format:check`                  | oxfmt                                                 |
| `bun run typecheck`                                | `tsc --noEmit`                                        |
| `bun run check`                                    | typecheck + lint + format:check + test (what CI runs) |
| `bun run env:check`                                | Validate the environment (`varlock load`)             |
| `bun run db:generate` / `db:migrate` / `db:studio` | drizzle-kit (Phase 3+)                                |

> ⚠️ Use **`bun run test`**, not `bun test` — the latter invokes Bun's own test runner.
> This project uses Vitest.

## Testing

Two projects (config in [`vitest.config.ts`](./vitest.config.ts)):

- **`unit`** — fast, colocated `src/**/*.test.ts`. Pure functions tested directly; services
  tested with in-memory Effect layers. We test **behavior through public interfaces**, not
  implementation, so refactors don't break tests.
- **`api`** — `test/api/**/*.api.test.ts` that call the **actual** Hono endpoints in-process
  via `app.request()` — the real middleware/routing/handler pipeline. DB-backed endpoint tests
  boot a real Postgres via Testcontainers (need Docker).
- **`integration`** — `test/integration/**/*.integration.test.ts` exercising real infra
  (Postgres via Testcontainers). `bun run test` covers unit + api; `bun run test:integration`
  runs this tier; `bun run test:unit` is the fast, Docker-free loop.

## Environment in 30 seconds

- `.env.schema` is committed and documents every variable (type, docs link, whether it's a
  secret, and where it's required). It contains **no secret values**.
- Local dev points the real drivers at emulators (LocalStack S3, personal Resend) — the
  one-time setup and the `.env.local` values are in [docs/local-dev.md](./docs/local-dev.md).
- Every command wraps `varlock run` for you — you never invoke varlock directly.
- Missing/invalid vars fail fast at boot with a clear message (and a docs link) telling you
  exactly what to set.

## Project structure

```
src/
  domain/    # pure types, schemas, branded ids, tagged errors (no I/O, no framework)
  modules/   # one folder per feature: routes · service · repo · policy · contract
  infra/     # shared Effect services (config, db, logger, auth, ids, cache, …)
  http/      # Hono app, middleware, error mapping, response helpers
  lib/       # framework-agnostic pure utilities
  db/schema/ # Drizzle tables (the one intentional barrel)
test/api/    # endpoint tests
```

See [`docs/architecture.md`](./docs/architecture.md) for the layering rules and
[`docs/conventions.md`](./docs/conventions.md) for the coding standards.

## What's here

The scaffold is complete — every pattern has a working, tested reference implementation:

- **Health**: `GET /livez`, `GET /readyz` (real Postgres probe, drains on shutdown).
- **Notes** (`/v1/notes`) — the reference feature module: full CRUD, cursor pagination,
  optional client-supplied UUIDv7 ids (`409` on duplicates), `422` validation envelope.
- **Auth** (better-auth): `/api/auth/*` (email/password enabled), session middleware, and
  `GET /v1/me` as the reference protected route.
- **API docs**: OpenAPI 3.1 at `/openapi.json`, Scalar UI at `/docs`, auth endpoints
  documented at `/api/auth/reference`.
- **Hardening**: secure headers, CORS (config-driven), 1 MB body limit, rate limiting
  (in-process, Redis-swappable seam), stable error-code catalog, import-boundary +
  naming + migration-drift checks in CI, production `Dockerfile` (`varlock run -- bun`).

Adding a feature = follow [`docs/adding-a-module.md`](./docs/adding-a-module.md) step by step.
