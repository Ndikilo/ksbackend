import { Config, Effect, Redacted } from "effect";
import { createApp, setReady } from "./http/app";
import { loadAuthOptions, makeAuth } from "./infra/auth";
import { AppConfig } from "./infra/config";
import { makeResendClient } from "./infra/email";
import { makeRuntime } from "./runtime";

const { appEnv, port, corsOrigins, defaultLocale } = await Effect.runPromise(AppConfig);
const isProd = appEnv === "prod" || appEnv === "staging";

const runtime = makeRuntime(appEnv);

// Auth's email + S3 wiring (Promise-based edge; mirrors the Effect infra choice).
// The server always uses the REAL drivers — local points them at LocalStack (S3)
// and a personal Resend account via env. Fakes live only in the test harness.
const resendBaseUrl = await Effect.runPromise(
  Config.string("RESEND_BASE_URL").pipe(Config.withDefault("")),
);
const emailClient = makeResendClient(
  Redacted.value(await Effect.runPromise(Config.redacted("RESEND_API_KEY"))),
  await Effect.runPromise(Config.string("EMAIL_FROM")),
  resendBaseUrl === "" ? undefined : resendBaseUrl,
);

const s3 = {
  bucket: await Effect.runPromise(Config.string("S3_BUCKET")),
  region: await Effect.runPromise(Config.string("S3_REGION")),
};

const authOptions = await Effect.runPromise(loadAuthOptions);
const auth = makeAuth({
  ...authOptions,
  defaultLocale,
  emailClient,
  trustedOrigins: corsOrigins,
  // Drive better-auth's rate limiter (OTP send budgets) from OUR APP_ENV rather
  // than its NODE_ENV sniffing, so the control is deterministic through config.
  rateLimit: { enabled: isProd },
  s3,
});
const app = createApp(runtime, auth.instance, { corsOrigins, defaultLocale });

const server = Bun.serve({ port, fetch: app.fetch });
console.log(`kanasante-api listening on http://localhost:${server.port}`);

// Graceful shutdown: stop new traffic, release the runtime + auth pools, exit.
const shutdown = async (): Promise<void> => {
  setReady(false);
  await runtime.dispose();
  await auth.close();
  server.stop();
  process.exit(0);
};

process.on("SIGTERM", () => void shutdown());
process.on("SIGINT", () => void shutdown());
