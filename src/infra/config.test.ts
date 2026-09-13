import { it } from "@effect/vitest";
import { ConfigProvider, Effect } from "effect";
import { expect } from "vitest";
import { AppConfig } from "./config";

// Behavior test: we assert on the OUTPUT of reading config under a given
// environment, not on how it's read. A refactor of `config.ts` that preserves
// this behavior keeps these green.
it.effect("reads and coerces the environment through Effect Config", () =>
  Effect.gen(function* () {
    const config = yield* AppConfig;
    expect(config.appEnv).toBe("test");
    expect(config.port).toBe(8080);
  }).pipe(
    Effect.withConfigProvider(
      ConfigProvider.fromMap(
        new Map([
          ["APP_ENV", "test"],
          ["PORT", "8080"],
        ]),
      ),
    ),
  ),
);

it.effect("falls back to defaults when the environment is empty", () =>
  Effect.gen(function* () {
    const config = yield* AppConfig;
    expect(config.appEnv).toBe("local");
    expect(config.port).toBe(3000);
  }).pipe(Effect.withConfigProvider(ConfigProvider.fromMap(new Map()))),
);
