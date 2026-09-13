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
 */
export const startTestPostgres = async (): Promise<{
  readonly url: string;
  readonly stop: () => Promise<void>;
}> => {
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
