# Architecture

Feature-first, layered, Effect-based. This doc is the committed distillation of the layering
rules. (The broader planning doc, `docs/SCAFFOLDING_PLAN.md`, is local/git-ignored.)

## Layers & dependency direction

Dependencies point **inward** only:

```
http  ─▶  modules  ─▶  domain
  │          │           ▲
  └──────────┴─────────▶ infra (shared Effect services)
```

- **`domain/`** — pure. Types, `Schema` entities, branded IDs, tagged errors. **Zero I/O, zero
  framework imports.** Never imports from `modules`, `http`, or `infra`.
- **`modules/<feature>/`** — one folder per feature; everything for that feature lives together.
  Only its `*.routes.ts` / `*.contract.ts` (the HTTP surface) may import `http/` or hono packages.
- **`infra/`** — shared Effect services wrapping the outside world (config, db, logger, auth,
  ids, cache, rate-limiter). Never imports `modules/` or `http/`.
- **`http/`** — Hono wiring: root app, middleware, error mapping, response/pagination helpers.
- **`lib/`** — framework-agnostic pure utilities (no Effect, no domain, no internal imports).
- **`runtime.ts`** — the single `ManagedRuntime` / `Effect.provide`.

The dependency direction is **machine-enforced**: `scripts/check-structure.ts` (part of
`bun run check` and CI) parses every import and fails the build on a violation.

## Auth boundary

better-auth is Promise-based and owns its own tables (`user`, `session`, `account`,
`verification` — generated into `src/db/schema/auth.ts` by its CLI; never hand-edit). It is
quarantined at the HTTP edge:

- Its routes are mounted **outside Effect**: `app.on(..., "/api/auth/*", c => auth.handler(...))`.
- A session middleware resolves `auth.api.getSession` and sets `c.var.user` (or `null`).
- Protected routes 401 when `c.var.user` is null, otherwise **provide `CurrentUser`**
  (`src/infra/auth.ts`) into the request's Effect — services/policies read `CurrentUser` from
  the context, never from Hono.
- The auth instance is **passed to `createApp(runtime, auth)`** as a parameter, not a runtime
  service — tests build the app with a dummy instance.

## Swappable backends (cache, rate limiting)

`Cache` and `RateLimiter` (`src/infra/`) are single tags with in-process implementations —
the app runs perfectly with no Redis, even in prod. When Redis/KeyDB is provisioned, implement
the Redis layer in the same file and swap one line in `runtime.ts`; no call site changes.

## Folder map

```
src/
  domain/<feature>/{<feature>.ts, errors.ts}
  domain/shared/{id.ts, pagination.ts, timestamps.ts, errors.ts}
  modules/<feature>/
    <feature>.routes.ts     # createRoute defs + THIN handlers
    <feature>.contract.ts   # Zod request/response schemas (feed OpenAPI)
    <feature>.service.ts    # Context.Tag + Layer.effect — business logic
    <feature>.repo.ts       # Context.Tag + Layer.effect — ONLY place Drizzle lives
    <feature>.policy.ts     # authorization decisions
    <feature>.test.ts
  infra/{config,db,logger,tracing,auth,ids,cache,rate-limiter}.ts
  http/{app.ts, response.ts, middleware/}
  db/schema/{index.ts, auth.ts (generated), <feature>.ts}
  lib/
  runtime.ts   server.ts
test/api/**/*.api.test.ts
```

## Decision rules

### Plain function vs Effect Service vs utility

| It is a…             | when…                                                                                          | lives in                                             |
| -------------------- | ---------------------------------------------------------------------------------------------- | ---------------------------------------------------- |
| **Pure function**    | deterministic transform of inputs, no I/O, no deps, no state                                   | `domain/` or `lib/`                                  |
| **Effect Service**   | has a dependency, holds a resource, does I/O, is non-deterministic, or you'd swap it in a test | `infra/` or `modules/<f>/*.service.ts` / `*.repo.ts` |
| **Utility (`lib/`)** | pure, generic, framework-agnostic, reused across features                                      | `lib/`                                               |

Rule of thumb: **if you'd ever fake/swap it in a test, it's a Service** (behind a tag).
`domain/` and `lib/` functions have `R = never`.

### Class vs plain function

Classes appear **only** as: `Context.Tag` service tags (paired with a `Layer.effect`/`Layer.succeed`
`*Live`), tagged errors (`Data.TaggedError` / `Schema.TaggedError`), and `Schema.Class` entities.
No OOP service classes, no `new` for business logic.

### `type` vs `interface`

Default `type`. Use `interface` only for declaration merging (e.g. Hono `Variables`/`Bindings`)
or a service's public method surface.

## What goes where (freeze these one-liners)

- **Route/handler** — translates HTTP ↔ a service call; no business rules.
- **Service** — business logic; knows nothing about HTTP.
- **Repository** — only place Drizzle/SQL lives; maps rows ↔ domain; no business rules.
- **Domain** — pure types/schemas/errors.
- **Policy** — "is this actor allowed?"; called by the service.

Cross-cutting concerns (request-id, logging, CORS, body limits, session, rate-limit) are
**middleware**. Business decisions are never in middleware. Validation lives at the route via
`createRoute` schemas. Error → HTTP mapping happens once, centrally, in `app.onError`.
