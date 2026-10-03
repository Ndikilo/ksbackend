import { Config, Effect, Layer, Logger } from "effect";
import { initLogger, log, type LoggerConfig } from "evlog";
import { createOTLPDrain } from "evlog/otlp";
import { AppConfig } from "./config";

// Map an Effect log record onto evlog. evlog is the transport; the drain
// (provider) is env-gated: with LOG_DRAIN_OTLP_ENDPOINT set, wide events also
// go to that OTLP/HTTP endpoint (Grafana Cloud, Axiom, Datadog, a self-hosted
// collector, …); without it, events go to evlog's console sink only. Adding or
// changing the sink needs zero changes here or at any call site.
const forwardToEvlog = Logger.make(({ logLevel, message }) => {
  const event = {
    level: logLevel.label,
    message: String(message),
  };
  switch (logLevel._tag) {
    case "Fatal":
    case "Error":
      log.error(event);
      break;
    case "Warning":
      log.warn(event);
      break;
    case "Debug":
    case "Trace":
      log.debug(event);
      break;
    default:
      log.info(event);
  }
});

/** Auth headers for the OTLP drain, keyed by header name. */
export type DrainHeaders = { readonly [key: string]: string };

/**
 * Parse `LOG_DRAIN_OTLP_HEADERS` — comma-separated `Key=Value` auth headers
 * (values may contain `=`; empty parts and keyless parts are skipped).
 */
export const parseDrainHeaders = (raw: string): DrainHeaders => {
  const entries: Array<[string, string]> = [];
  for (const part of raw.split(",")) {
    const entry = part.trim();
    const separator = entry.indexOf("=");
    if (separator <= 0) continue;
    entries.push([entry.slice(0, separator).trim(), entry.slice(separator + 1).trim()]);
  }
  return Object.fromEntries(entries);
};

/**
 * Installs evlog as the logging transport:
 *   - initialises evlog once with the service name + resolved environment and
 *     — only when LOG_DRAIN_OTLP_ENDPOINT is set — an OTLP log drain, and
 *   - replaces Effect's default logger so `Effect.log*` flows through evlog.
 *
 * Per-request "wide events" are handled by evlog's Hono middleware in the app.
 */
export const LoggerLive = Layer.merge(
  Layer.effectDiscard(
    Effect.gen(function* () {
      const { appEnv } = yield* AppConfig;
      const endpoint = (yield* Config.string("LOG_DRAIN_OTLP_ENDPOINT").pipe(
        Config.withDefault(""),
      )).trim();
      const config: LoggerConfig = { env: { service: "kanasante-api", environment: appEnv } };
      if (endpoint !== "") {
        const headerRaw = yield* Config.string("LOG_DRAIN_OTLP_HEADERS").pipe(
          Config.withDefault(""),
        );
        config.drain = createOTLPDrain({ endpoint, headers: parseDrainHeaders(headerRaw) });
      }
      initLogger(config);
    }),
  ),
  Logger.replace(Logger.defaultLogger, forwardToEvlog),
);
