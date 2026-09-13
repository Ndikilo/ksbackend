import { makeAuth } from "./infra/auth";
import { makeConsoleClient } from "./infra/email";

// Config consumed by `@better-auth/cli generate` (which introspects this `auth`
// export to produce src/db/schema/auth.ts). Edge/tooling boundary — reads env
// directly (see .oxlintrc override). The application builds its auth instance
// from Effect Config via `makeAuth` + `loadAuthOptions` (src/infra/auth.ts).
export const auth = makeAuth({
  databaseUrl:
    process.env.DATABASE_URL ?? "postgres://kanasante:kanasante@localhost:5432/kanasante",
  secret: process.env.BETTER_AUTH_SECRET ?? "dev-only-insecure-secret-change-in-production-000",
  baseURL: process.env.BETTER_AUTH_URL ?? "http://localhost:3000",
  defaultLocale: "fr",
  emailClient: makeConsoleClient(),
}).instance;
