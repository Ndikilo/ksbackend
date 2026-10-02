import { it } from "@effect/vitest";
import { Cause, ConfigError, ConfigProvider, Effect, Exit, Option } from "effect";
import { describe, expect } from "vitest";
import { loadAuthOptions } from "./auth";

// Behavior tests over the BETTER_AUTH_SECRET policy: required (non-empty) in
// prod/staging — boot fails loudly otherwise; a labeled dev-only fallback is
// allowed everywhere else.
const loadWith = (env: Readonly<Record<string, string>>) =>
  loadAuthOptions.pipe(
    Effect.withConfigProvider(ConfigProvider.fromMap(new Map(Object.entries(env)))),
  );

const realSecret = "real-secret-value-at-least-32-characters-long!!";
const base = { DATABASE_URL: "postgres://test:test@localhost:5432/test" };

// The message of a missing REDACTED var renders as "<redacted>", but the error
// path names the variable — assert on both the kind and the path.
const expectMissingSecret = (exit: Exit.Exit<unknown, ConfigError.ConfigError>): void => {
  expect(Exit.isFailure(exit)).toBe(true);
  if (Exit.isFailure(exit)) {
    const failure = Cause.failureOption(exit.cause);
    expect(Option.isSome(failure)).toBe(true);
    if (Option.isSome(failure)) {
      if (failure.value._op === "MissingData") {
        expect(failure.value.path.join(".")).toContain("BETTER_AUTH_SECRET");
      } else {
        expect.unreachable(`expected MissingData, got ${failure.value._op}`);
      }
    }
  }
};

describe("loadAuthOptions — BETTER_AUTH_SECRET policy", () => {
  it.effect("fails loudly in prod when the secret is missing", () =>
    Effect.gen(function* () {
      expectMissingSecret(yield* Effect.exit(loadWith({ ...base, APP_ENV: "prod" })));
    }),
  );

  it.effect("fails loudly in staging when the secret is missing", () =>
    Effect.gen(function* () {
      expectMissingSecret(yield* Effect.exit(loadWith({ ...base, APP_ENV: "staging" })));
    }),
  );

  it.effect("fails loudly in prod when the secret is empty", () =>
    Effect.gen(function* () {
      const exit = yield* Effect.exit(
        loadWith({ ...base, APP_ENV: "prod", BETTER_AUTH_SECRET: "   " }),
      );
      expect(Exit.isFailure(exit)).toBe(true);
      if (Exit.isFailure(exit)) {
        const failure = Cause.failureOption(exit.cause);
        expect(Option.isSome(failure)).toBe(true);
        if (Option.isSome(failure)) {
          if (failure.value._op === "InvalidData") {
            expect(failure.value.message).toContain("BETTER_AUTH_SECRET");
          } else {
            expect.unreachable(`expected InvalidData, got ${failure.value._op}`);
          }
        }
      }
    }),
  );

  it.effect("passes a real secret through in prod", () =>
    Effect.gen(function* () {
      const exit = yield* Effect.exit(
        loadWith({ ...base, APP_ENV: "prod", BETTER_AUTH_SECRET: realSecret }),
      );
      expect(Exit.isSuccess(exit)).toBe(true);
      if (Exit.isSuccess(exit)) {
        expect(exit.value.secret).toBe(realSecret);
      }
    }),
  );

  it.effect("falls back to the labeled dev-only secret outside prod when unset", () =>
    Effect.gen(function* () {
      const exit = yield* Effect.exit(loadWith({ ...base, APP_ENV: "local" }));
      expect(Exit.isSuccess(exit)).toBe(true);
      if (Exit.isSuccess(exit)) {
        expect(exit.value.secret).toContain("dev-only-insecure-secret");
      }
    }),
  );
});
