import { Effect, Layer, Logger } from "effect";
import { initLogger, log } from "evlog";
import { AppConfig } from "./config";

// Map an Effect log record onto evlog. evlog is the transport; the drain
// (provider) is not chosen yet (docs/SCAFFOLDING_PLAN.md §12), so events go to
// evlog's default sink for now. Adding a drain in `initLogger` later routes them
// to Axiom/Datadog/OTLP/etc. with zero changes here or at any call site.
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

/**
 * Installs evlog as the logging transport:
 *   - initialises evlog once with the service name + resolved environment, and
 *   - replaces Effect's default logger so `Effect.log*` flows through evlog.
 *
 * Per-request "wide events" are handled by evlog's Hono middleware in the app.
 */
export const LoggerLive = Layer.merge(
  Layer.effectDiscard(
    Effect.gen(function* () {
      const { appEnv } = yield* AppConfig;
      initLogger({ env: { service: "kanasante-api", environment: appEnv } });
    }),
  ),
  Logger.replace(Logger.defaultLogger, forwardToEvlog),
);
