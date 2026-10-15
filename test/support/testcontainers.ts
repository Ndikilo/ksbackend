import * as PgDrizzle from "@effect/sql-drizzle/Pg";
import { PgClient } from "@effect/sql-pg";
import { PostgreSqlContainer } from "@testcontainers/postgresql";
import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { Effect, Layer, Redacted } from "effect";
import { pgTypeConfig } from "@/infra/db";

// Apply the committed drizzle migrations to the fresh container so DB-backed
// tests run against the real schema (no drift — same migrations as production).
const applyMigrations = async (url: string): Promise<void> => {
  const db = drizzle(url);
  await migrate(db, { migrationsFolder: "drizzle" }).finally(() => db.$client.end());
};

/** The Effect database layer pointed at a given Postgres URL. */
export const databaseLayerFromUrl = (url: string) =>
  PgDrizzle.layer.pipe(
    Layer.provideMerge(PgClient.layer({ url: Redacted.make(url), types: pgTypeConfig })),
  );

/**
 * A live database layer backed by a throwaway, migrated Postgres container.
 * Starts on layer acquisition, stops when the scope closes — each suite gets a
 * real, isolated Postgres with the schema applied.
 */
export const TestDatabaseLive = Layer.unwrapScoped(
  Effect.gen(function* () {
    const container = yield* Effect.acquireRelease(
      Effect.promise(() => new PostgreSqlContainer("postgres:17").start()),
      (started) => Effect.promise(() => started.stop()),
    );
    const url = container.getConnectionUri();
    yield* Effect.promise(() => applyMigrations(url));
    return databaseLayerFromUrl(url);
  }),
);

/**
 * Start a migrated Postgres container and return its URL + a stop function.
 * Used when a test needs the URL to wire something outside the Effect layer too
 * (e.g. better-auth's own pool), so both point at the same database.
 *
 * Escape hatch: when TEST_DATABASE_URL is set (a machine without Docker can
 * run the real-DB tier against a local instance), it is used in place of the
 * container, migrations are applied, and `stop` becomes a no-op — the caller
 * owns that database's lifecycle.
 */
export const startTestPostgres = async (): Promise<{
  readonly url: string;
  readonly stop: () => Promise<void>;
}> => {
  const externalUrl = process.env.TEST_DATABASE_URL;
  if (externalUrl !== undefined && externalUrl !== "") {
    await applyMigrations(externalUrl);
    return { url: externalUrl, stop: async () => {} };
  }
  const container = await new PostgreSqlContainer("postgres:17").start();
  const url = container.getConnectionUri();
  await applyMigrations(url);
  return {
    url,
    stop: async () => {
      await container.stop();
    },
  };
};
