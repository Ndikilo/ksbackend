import { SqlClient } from "@effect/sql";
import { Context, Effect, Layer } from "effect";

export interface HealthService {
  /** Whether the app can serve traffic — currently a Postgres round-trip. */
  readonly ready: Effect.Effect<boolean>;
}

/**
 * Readiness as a service. Modelling it as a `Context.Tag` (rather than probing
 * the DB inline in the handler) means tests inject a trivial fake and stay
 * Docker-free, while production/integration back it with the real database.
 */
export class Health extends Context.Tag("Health")<Health, HealthService>() {}

/** Real readiness: pings Postgres. Requires `SqlClient` (from `DatabaseLive`). */
export const HealthLive = Layer.effect(
  Health,
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const ready = sql`select 1`.pipe(
      Effect.as(true),
      Effect.catchAll(() => Effect.succeed(false)),
    );
    return { ready };
  }),
);
