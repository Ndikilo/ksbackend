import * as PgDrizzle from "@effect/sql-drizzle/Pg";
import { PgClient } from "@effect/sql-pg";
import { Config, Duration, Layer } from "effect";
import { type CustomTypesConfig, types as pgTypes } from "pg";

const DATE_OID = 1082;
const asRawString = (value: string): string => value;

/**
 * pg type parsers. `date` columns (e.g. dateOfBirth) are returned as raw
 * 'YYYY-MM-DD' strings — node-pg's default parses them into a local-midnight
 * `Date`, which shifts the day across timezones (a birth date is not a moment
 * in time). `timestamptz`/`timestamp` keep their default `Date` parsing, which
 * the domain relies on. Shared with the test harness so both behave identically.
 */
export const pgTypeConfig: CustomTypesConfig = {
  getTypeParser: (oid, format) =>
    oid === DATE_OID ? asRawString : pgTypes.getTypeParser(oid, format),
};

/**
 * Postgres connection pool as an Effect layer. Configured from the environment,
 * which varlock resolves + validates at the process edge; we read it here via
 * Effect `Config` (never `process.env`). The connection string stays `Redacted`
 * so it can't leak into logs.
 */
const PgLive = PgClient.layerConfig({
  url: Config.redacted("DATABASE_URL"),
  maxConnections: Config.integer("DB_POOL_MAX").pipe(Config.withDefault(10)),
  idleTimeout: Config.succeed(Duration.seconds(30)),
  applicationName: Config.succeed("kanasante-api"),
  types: Config.succeed(pgTypeConfig),
});

/**
 * The database layer.
 *
 * Provides both the low-level `SqlClient` — used for transactions via
 * `SqlClient.withTransaction` (NEVER Drizzle's `db.transaction()`, which throws
 * under the pg-proxy driver) — and the `PgDrizzle` query builder, which runs
 * through the same pooled connection. Repositories depend on `PgDrizzle` (and on
 * `SqlClient` when they own a transaction).
 */
export const DatabaseLive = PgDrizzle.layer.pipe(Layer.provideMerge(PgLive));
