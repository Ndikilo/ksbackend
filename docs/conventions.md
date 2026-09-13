# Conventions

Coding standards for kanasante/api. These are enforced by `tsconfig.json` + `.oxlintrc.json`
where possible; the rest are review/CI rules. When in doubt, this doc + `docs/architecture.md`
win.

## TypeScript

- **No `any`** (`typescript/no-explicit-any` = error). Use `unknown` + narrowing/decoding.
- **No `as` casts** except `as const` and `satisfies`. Never cast untrusted/loosely-typed data —
  **decode it** with Zod / `Schema` ("parse, don't cast").
- **No non-null assertions (`!`)**. Handle the `undefined`/`null` case
  (`noUncheckedIndexedAccess` makes array/object access honest).
- **No TS `enum`** — use string-literal unions + `Schema.Literal` / `z.enum`, and `pgEnum` in the DB.
- Prefer **`readonly` / `ReadonlyArray`**; domain entities are immutable.
- **Branded IDs** — a `UserId` is not assignable from a raw `string`; construct via its schema/brand.
- **Exhaustiveness** — end a discriminated-union `switch` with `assertNever(x)` (see `src/lib/assert-never.ts`).
- Prefer **`satisfies`** over annotations when you want inference + a constraint.

`tsconfig` is strict + `noUncheckedIndexedAccess` + `exactOptionalPropertyTypes` +
`verbatimModuleSyntax` + `noUnusedLocals/Parameters`.

## Effect

- **One runtime boundary** — `runPromise`/`runFork` only in `http/` handlers and `server.ts`.
  Services **return** Effects; they never run them.
- **One `Effect.provide`** — all layers merge into one `AppLayer` → one `ManagedRuntime`.
  Downstream code only _declares_ requirements in its `R` channel.
- **Typed error channel** — wrap every external promise/SDK/throwing call in
  `Effect.tryPromise({ try, catch })` mapping to a **tagged error**. No `unknown` errors escape.
- **Config via `Config`** — never read `process.env` in application logic.
- **Determinism** — never argless `new Date()` / `Date.now()` / `Math.random()`; read the wall
  clock via Effect `Clock` (`new Date(yield* Clock.currentTimeMillis)` is fine — the value is
  injected and `TestClock`-controllable). Non-determinism (e.g. UUIDs) hides behind a seam
  (`IdGenerator`). Enforced by `check:structure`.
- **Concurrency** via `Effect.forEach(xs, f, { concurrency })` / `Effect.all(_, { concurrency })` —
  not `Promise.all`, and not the default sequential mode when the effects are independent.
- **Transactions** via `SqlClient.withTransaction` — never Drizzle's `db.transaction()`. Any
  operation with more than one dependent write (row + audit row, profile + role) must be wrapped.
- Optional reads return `A | undefined` from repos/services; convert to `null`/omitted at the HTTP
  boundary. (`Option<A>` is available but not required — stay consistent with the surrounding code.)
- **Tracing (optional):** wrapping a service method in `Effect.fn("Domain.operation")` gives a
  named span; adopt it where richer traces help. Not currently required or uniformly applied.

## HTTP contracts

- **Error envelope:** `{ error: { code, message, details }, requestId }`. `code` is stable
  `SCREAMING_SNAKE`, decoupled from HTTP status + message; every tagged error maps to one
  `(status, code)` centrally in `app.onError`. Services never build HTTP responses.
- **Success:** single resource → the object **directly** (no `data` wrapper). Mutation w/o body → `204`.
- **Lists → `{ data, meta }`**, cursor/keyset by default:
  `meta: { count, limit, nextCursor, hasNextPage }`. Request `?limit&cursor`, `limit` ≤ 100,
  a stable descending order. Ids are UUIDv7 (time-sortable + unique), so `ORDER BY id DESC` with
  an `id < cursor` keyset is a valid stable order on its own; add a `createdAt` tiebreaker only for
  non-UUIDv7 keys. Offset/page (`page, pageSize, total, pageCount, …`) is an opt-in per-endpoint
  exception. Never return a bare array.
- **Validation both ways** via `@hono/zod-openapi` `createRoute` — request schemas validate input
  _and_ feed OpenAPI; the response schema is declared and enforced at compile time.
- Methods/status: plural kebab nouns under `/v1`; `PATCH` for partial update; `409` on duplicate
  (incl. client-supplied id); `422` validation; `429` rate-limited.
- **Client-supplied ids:** create endpoints accept an optional UUIDv7 `id` (optimistic UI);
  absent → server/DB generates; duplicate → `409`.
- **Limits:** global `bodyLimit` (1 MB → `413 PAYLOAD_TOO_LARGE`); every request string field has
  an explicit `.max(...)`. Global rate limiting (in-process fixed window; Redis-swappable) →
  `429 RATE_LIMITED` + `Retry-After`; health probes exempt.
- **Auth:** better-auth owns `/api/auth/*` (outside Effect). Protected routes read `c.var.user`,
  401 when null, and provide `CurrentUser` into the Effect (see `src/http/me.routes.ts` as the
  reference implementation).

## Naming & files

### Files (machine-enforced)

- **kebab-case filenames** everywhere — enforced by oxlint `unicorn/filename-case`.
- **Module files:** `<feature>.<role>.ts`, role ∈ `routes | service | repo | policy | contract`
  (colocated unit test `<feature>.<role>.test.ts`). The folder name **is** the feature; every file
  in it starts with that feature name. A module may **nest sub-feature folders** for a cohesive
  slice — e.g. `practitioner/search/search.repo.ts` — where the required prefix is the name of the
  folder the file lives in (use this for query _facets_ like search; give things with their own
  table/lifecycle a top-level module instead). Enforced by `scripts/check-structure.ts`.
- **API tests:** live only under `test/api/**` and are named `*.api.test.ts`. Enforced by the same script.
- **Unit tests:** colocated as `src/**/*.test.ts`.
- **Domain/infra/lib/middleware:** kebab-case; named by concern (e.g. `request-id.ts`, `config.ts`).
- **One primary export per file**, named after the file. **No barrels** except `db/schema/index.ts`
  and a module's deliberate public surface. Imports auto-ordered by oxfmt.
- **Imports:** use the `@/*` → `src/*` alias for any cross-directory import into `src`
  (`@/infra/auth`, not `../../infra/auth`); keep same-directory imports relative (`./email`).
  Resolution is declared in three places that must stay in sync: `tsconfig.json` `paths`
  (types + Bun runtime), `vitest.config.ts` `resolve.alias` (tests), and `check-structure.ts`
  (boundary parser). `db/schema/*` files stay same-dir relative so drizzle-kit needs no alias.

### Identifiers (review-enforced — see note)

- **Types, classes, `Schema` entities, Effect service tags, tagged-error tags:** `PascalCase`
  (`UserService`, `UserNotFound`, `WidgetId`).
- **Functions, variables, service methods:** `camelCase` (`findById`, `createWidget`).
- **Constants / enum-like literal unions:** values are `SCREAMING_SNAKE` when they're wire/error
  codes; otherwise lowercase literals.
- **Span names** (when `Effect.fn` is used — see the optional tracing note above) follow
  `PascalCaseFeature.camelCaseOperation` (e.g. `Effect.fn("User.create")`).

> Note: oxlint does not yet implement `naming-convention`/`camelcase`, so identifier casing is a
> **review rule**, not a lint error (TypeScript itself doesn't enforce casing). Filenames, structure,
> and `no-process-env` **are** enforced automatically. Revisit when oxlint adds naming-convention.

## Database

- Table names **singular** (aligns with better-auth); TS properties camelCase, DB columns snake_case.
- Every table: `id` (UUIDv7), `createdAt`, `updatedAt` (`timestamptz`, UTC). Soft delete via nullable `deletedAt`.
- Enums as `pgEnum` ↔ `Schema.Literal`; money as integer minor units; wire timestamps ISO-8601 UTC.

## Size / complexity (warnings, not blockers)

`max-lines` ~300/file, `max-lines-per-function` ~60, cognitive-complexity ~15, `max-depth` 4,
`max-params` 3 (prefer an options object). Formatting + import order are **hard** (CI fails).

## Testing

- Test **behavior through public interfaces**, not internals. Assert on outcomes/state, not
  interactions. A behavior-preserving refactor keeps tests green.
- Swap dependencies with **in-memory Effect layers**, not call-recording mocks.
- **Unit:** `src/**/*.test.ts` — pure functions directly; services with test layers; `@effect/vitest`
  `it.effect` + `TestClock` for time.
- **API:** `test/api/**/*.api.test.ts` — real endpoints via `app.request()` (from Phase 5, backed by
  the Testcontainers DB layer).
- **Integration:** `test/integration/**/*.integration.test.ts` — exercise real infra (Postgres via
  Testcontainers) using the shared harness `test/support/testcontainers.ts`. Needs Docker.
- `bun run test` = unit + api (fast, no Docker). `bun run test:integration` = integration tier.
  Never `bun test` (Bun's runner). Pin `vitest@^3.2` (matches `@effect/vitest`).

### Tautological tests considered harmful

A test is **tautological** when it cannot fail for the reason it claims to check — it restates the
implementation, the type system, or its own fixture. Before writing an assertion, ask: **what change
to production code would turn this red?** If the honest answer is "nothing", or "something `tsc`
would reject first", don't write it. If you find one, delete it or replace it with the invariant it
was pretending to check.

Smells:

- **Text-grepping a generated artifact.** `expect(spec).toContain("/v1/foo")` against a document
  generated from the same call that serves `/v1/foo` — with `app.openapi(...)`, registering and
  documenting a route are one act. `test/api/openapi.api.test.ts` is the honest version: derive the
  expectation from the router itself, so a route added with `app.get` is caught.
- **A hand-maintained list checked against itself.** A list literal in the test that only ever
  changes alongside the code it "covers" is a change-detector, not a test.
- **Re-deriving the expectation with production logic.** Compute expected values by hand or from the
  spec — never by calling the code under test, or a copy of it pasted into the test.
- **Asserting what the types or the contract already pin.** `typeof x === "string"`,
  `expect(x).toBeDefined()` on a non-nullable, or a field the response schema declares as
  `z.literal(false)`.
- **Asserting the fixture.** A fake returns `X`; asserting the caller got `X` tests the fake.

Prefer assertions that name the offender when they fail: `expect(xs.filter(bad)).toEqual([])` beats
`expect(xs.every(ok)).toBe(true)`, which only ever reports "expected false to be true".
