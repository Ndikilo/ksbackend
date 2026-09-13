# Adding a feature module

A literal recipe. Follow the steps in order; each file has one job (see
`docs/architecture.md`). Example feature: `widget`.

1. **Domain** — `src/domain/widget/widget.ts` (Schema entity + branded `WidgetId`) and
   `src/domain/widget/errors.ts` (tagged errors, e.g. `WidgetNotFound`). Pure; no I/O.

2. **DB schema** — add the table to `src/db/schema/widget.ts`, export it from
   `src/db/schema/index.ts`, then:

   ```bash
   bun run db:generate   # drizzle-kit writes the SQL migration
   bun run db:migrate     # apply it
   ```

3. **Repository** — `src/modules/widget/widget.repo.ts`: a `Context.Tag` service + `WidgetRepoLive`
   (`Layer.effect`) depending on `PgDrizzle`. The only place SQL lives. Maps rows ↔ domain; returns
   tagged errors, not throws. Multi-statement writes use `SqlClient.withTransaction` (inject
   `SqlClient` into the service and wrap the repo calls).

4. **Service** — `src/modules/widget/widget.service.ts`: a `Context.Tag` service + `WidgetServiceLive`
   (`Layer.effect`) with the business logic. Orchestrates the repo + other services. No HTTP.
   Optionally wrap methods with `Effect.fn("Widget.create")` for named traces.

5. **Policy** — `src/modules/widget/widget.policy.ts`: authorization decisions as Effects,
   invoked by the service.

6. **Contract** — `src/modules/widget/widget.contract.ts`: Zod request + response schemas
   (reusing `domain/shared` primitives; list responses use the shared `paginated()` helper).

7. **Routes** — `src/modules/widget/widget.routes.ts`: `createRoute` definitions + THIN handlers.
   Decode input → run the Effect via the runtime → map result/error to a Response.

8. **Mount** — register the module's routes in `src/http/app.ts` and its layers in the app
   runtime.

9. **Tests** —
   - `src/modules/widget/widget.service.test.ts`: unit tests with an in-memory repo layer.
   - `test/api/widget.api.test.ts`: hit the real endpoints via `app.request()` against Postgres.

10. **Verify** — `bun run check`, and confirm the endpoints appear in the OpenAPI spec at `/doc`
    with a unique `operationId` and the feature `tags`.

Checklist: pure domain? SQL only in the repo? no business rules in the handler? request **and**
response validated? errors mapped centrally? list paginated with the standard envelope?
