#!/usr/bin/env bun
/**
 * Apply drizzle migrations (idempotent, journal-tracked).
 *
 * Runs inside the production image on every boot (scripts/start.sh) BEFORE the
 * server starts. Unlike drizzle-kit (a dev dependency), this uses only
 * `drizzle-orm`, which is already in the runtime image. Reads env directly
 * (edge script, same as seed.ts).
 */
import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) {
  throw new Error("DATABASE_URL is not set — cannot run migrations.");
}

const db = drizzle(databaseUrl);
await migrate(db, { migrationsFolder: "./drizzle" });
console.log("[migrate] migrations applied");
process.exit(0);
