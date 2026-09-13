import { defineConfig } from "drizzle-kit";

// drizzle-kit is the single migration authority for the whole database
// (including better-auth's generated tables). See docs/SCAFFOLDING_PLAN.md §13.
//
// This is a drizzle-kit CLI config, NOT part of the Effect app — it is the one
// legitimate place `process.env` is read directly. The db:* scripts run it via
// `varlock run -- drizzle-kit`, so varlock resolves + validates the environment
// and injects DATABASE_URL here. Application code never touches process.env; it
// reads typed values through Effect `Config` (see src/infra/config.ts).
//
// No default/fallback: if DATABASE_URL is absent we fail loudly rather than
// silently pointing migrations at some guessed database.
const url = process.env.DATABASE_URL;
if (!url) {
  throw new Error(
    "DATABASE_URL is not set. Run drizzle-kit via the db:* scripts (which wrap `varlock run`), e.g. `bun run db:migrate`.",
  );
}

export default defineConfig({
  dialect: "postgresql",
  schema: "./src/db/schema/index.ts",
  out: "./drizzle",
  dbCredentials: { url },
});
