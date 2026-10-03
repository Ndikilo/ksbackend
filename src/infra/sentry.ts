import type { BaseTransportOptions, Transport } from "@sentry/core";
import type { BunOptions } from "@sentry/bun";

/**
 * Backend error reporting (Sentry). The SDK is loaded through a DYNAMIC import
 * and only when a `SENTRY_DSN` is configured, so a deployment without one pays
 * zero overhead: no client, no global handlers, not even a module load. All
 * capture calls degrade to immediate no-ops in that state.
 *
 * The optional `transport` injection exists for tests: passing an in-memory
 * transport lets the api suite prove that errors thrown in routes reach the
 * reporting pipeline with the right tags, without any network access.
 */
type SentryModule = typeof import("@sentry/bun");

export type SentryTransportFactory = (options: BaseTransportOptions) => Transport;

export type SentryOptions = {
  /** Ingest DSN. Empty/whitespace disables Sentry entirely. */
  readonly dsn: string;
  /** Environment label on every event (mirrors APP_ENV). */
  readonly environment: string;
  /** Test seam: replace the network transport (e.g. an in-memory recorder). */
  readonly transport?: SentryTransportFactory;
};

// The loaded SDK, or undefined when disabled (no DSN / not yet initialized).
let sentry: SentryModule | undefined;

export const initSentry = async (options: SentryOptions): Promise<void> => {
  if (options.dsn.trim() === "") return;
  const mod = await import("@sentry/bun");
  const initOptions: BunOptions = { dsn: options.dsn, environment: options.environment };
  if (options.transport !== undefined) {
    initOptions.transport = options.transport;
  }
  // The Bun-server integrations crash at setup outside the Bun runtime (unit
  // tests run under Node via vitest) and only instrument Bun.serve, so drop
  // them there. Production runs on Bun and keeps the SDK's full defaults.
  if (!("Bun" in globalThis)) {
    initOptions.defaultIntegrations = mod
      .getDefaultIntegrationsWithoutPerformance()
      .filter(
        (integration) => integration.name !== "BunServer" && integration.name !== "BunHttpServer",
      );
  }
  mod.init(initOptions);
  sentry = mod;
};

export type CapturedApiError = {
  readonly error: unknown;
  /** Correlates the event with the API's error envelope + wide-event logs. */
  readonly requestId?: string | undefined;
  /** Signed-in user's roles at request time (unauthenticated → undefined). */
  readonly roles?: ReadonlyArray<string> | undefined;
};

/** Report an unhandled error. No-op unless initSentry ran with a DSN. */
export const captureApiError = ({ error, requestId, roles }: CapturedApiError): void => {
  const mod = sentry;
  if (mod === undefined) return;
  mod.withScope((scope) => {
    if (requestId !== undefined) scope.setTag("request_id", requestId);
    if (roles !== undefined && roles.length > 0) scope.setTag("user_roles", roles.join(","));
    mod.captureException(error);
  });
};

/**
 * Wait for queued events to reach the transport. Resolves `false` when Sentry
 * is disabled (nothing to flush).
 */
export const flushSentry = (timeoutMs = 2_000): Promise<boolean> =>
  sentry === undefined ? Promise.resolve(false) : sentry.flush(timeoutMs);
