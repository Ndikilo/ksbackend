import { Config } from "effect";

/**
 * Application configuration, read exclusively through Effect `Config`.
 *
 * varlock resolves and validates the environment at the process edge
 * (`varlock run -- …`); application code never reads `process.env` directly —
 * it reads typed values from here. See docs/SCAFFOLDING_PLAN.md §4.
 */
export const AppConfig = Config.all({
  appEnv: Config.literal(
    "local",
    "test",
    "ci",
    "staging",
    "prod",
  )("APP_ENV").pipe(Config.withDefault("local" as const)),
  port: Config.integer("PORT").pipe(Config.withDefault(3000)),
  corsOrigins: Config.string("CORS_ORIGINS").pipe(
    Config.withDefault("http://localhost:3000"),
    Config.map((raw) => raw.split(",").map((origin) => origin.trim())),
  ),
  // Locale used when a request sends no (or an unsupported) Accept-Language.
  defaultLocale: Config.literal(
    "en",
    "fr",
  )("DEFAULT_LOCALE").pipe(Config.withDefault("fr" as const)),
});
