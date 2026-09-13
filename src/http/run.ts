import { Cause, Effect, Exit, Option } from "effect";
import type { Context } from "hono";
import { Unauthorized } from "@/domain/shared/errors";
import { CurrentUser } from "@/infra/auth";
import type { AppEnv, AppRuntime, AppServices } from "./app-env";

// Turn a failure Cause into a thrown value so Hono's `onError` maps it centrally
// (src/http/error-mapper.ts). Throwing the actual tagged error — not the runtime's
// FiberFailure wrapper — is what lets `instanceof` narrowing in the mapper work.
const raise = (cause: Cause.Cause<unknown>): never => {
  const failure = Cause.failureOption(cause);
  throw Option.getOrElse(failure, () => new Error(Cause.pretty(cause)));
};

/**
 * The HTTP boundary helpers. A handler builds an Effect that yields its success
 * `Response` (a typed `c.json(...)`); we run it on the app runtime and, on
 * failure, raise so the central error mapper takes over. `runPromiseExit` lives
 * only here — services return Effects.
 */
export const makeRun = (runtime: AppRuntime) => {
  const run = async <A extends Response>(
    effect: Effect.Effect<A, unknown, AppServices>,
  ): Promise<A> => {
    const exit = await runtime.runPromiseExit(effect);
    return Exit.isSuccess(exit) ? exit.value : raise(exit.cause);
  };

  /** For authenticated routes: provides `CurrentUser` from the session, or 401s. */
  const runAuth = <A extends Response>(
    c: Context<AppEnv>,
    effect: Effect.Effect<A, unknown, AppServices | CurrentUser>,
  ): Promise<A> => {
    const user = c.get("user");
    if (user === null) {
      throw new Unauthorized({ reason: "Sign in to access this resource." });
    }
    return run(Effect.provideService(effect, CurrentUser, user));
  };

  return { run, runAuth };
};
