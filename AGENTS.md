# AGENTS.md — kanasante/api

A thin index for humans **and** AI agents. It points to the real docs; it does not duplicate
them. `CLAUDE.md` is a symlink to this file.

## Run it

```bash
bun run setup   # bootstrap (deps, .env.local, Postgres, env validation)
bun run dev     # start the API
bun run check   # what CI enforces: typecheck · structure · lint · format · test
```

Full command list + onboarding: **[README.md](./README.md)**.
Never use `bun test` (Bun's runner) — always `bun run test` (Vitest).

## Where things live

| Need                                                                                                     | Read                                                     |
| -------------------------------------------------------------------------------------------------------- | -------------------------------------------------------- |
| Layers, folders, "what goes where", decision rules (service vs util, class vs fn, `type` vs `interface`) | **[docs/architecture.md](./docs/architecture.md)**       |
| Coding standards: TypeScript, Effect, HTTP contracts, naming, testing                                    | **[docs/conventions.md](./docs/conventions.md)**         |
| Step-by-step recipe to add a feature                                                                     | **[docs/adding-a-module.md](./docs/adding-a-module.md)** |
| Full plan, seams, deferred decisions                                                                     | `docs/SCAFFOLDING_PLAN.md` (local, git-ignored)          |

## Non-negotiables (details in docs/conventions.md)

- No `any`, no `as` casts (decode, don't cast), no `!`, no TS `enum`. Enforced by tsconfig + oxlint.
- App code never reads `process.env` — use Effect `Config` (`no-process-env` is a lint error; only
  tooling configs under `varlock run` may read it).
- `runPromise` only at the HTTP/server edge; services return Effects.
- Determinism: no `Date.now()`/`new Date()`/`Math.random()` — use Effect `Clock`/`Random`.
- DB transactions via `SqlClient.withTransaction`, never Drizzle's `db.transaction()`.
- HTTP: standard error envelope `{ error: { code, message, details }, requestId }`; single resource =
  bare object; lists = `{ data, meta }` (cursor pagination). Validate request **and** response.
- Auth: better-auth owns `/api/auth/*`; protected routes 401 then provide `CurrentUser` into the
  Effect (reference: `src/http/me.routes.ts`). `src/db/schema/auth.ts` is generated — never hand-edit.
- Import boundaries (`domain ← modules ← http`, `infra`/`lib` leaves) are machine-enforced by
  `bun run check:structure` — a violation fails the build.
- **Tautological tests considered harmful.** Every test must be able to fail for the reason it
  claims to check — never assert a fixture back at itself, a hand-maintained list, or something
  `tsc` already pins. Ask "what production change turns this red?" before writing an assertion, and
  delete the ones with no answer (details + smells in
  [docs/conventions.md → Testing](./docs/conventions.md#tautological-tests-considered-harmful)).

## Conventions are enforced, not suggested

`bun run check` runs: `tsc` (strict) · `check:structure` (role-suffix/area file patterns) ·
`oxlint` (incl. kebab-case filenames + `no-process-env`) · `oxfmt --check` · `vitest`
(unit + api). If it's not green, it doesn't merge.
