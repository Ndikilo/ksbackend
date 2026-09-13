import { Context, Effect, Layer } from "effect";
import { v7 as uuidv7 } from "uuid";

export interface IdGeneratorService {
  /** A fresh UUIDv7 — time-sortable, which is what makes keyset pagination by id work. */
  readonly next: Effect.Effect<string>;
}

/**
 * ID generation behind a service seam. The real impl uses UUIDv7; tests inject a
 * deterministic fake. This is how we honour the "no `Date.now`/`Math.random` in
 * app logic" rule — the non-determinism is encapsulated and swappable here.
 */
export class IdGenerator extends Context.Tag("IdGenerator")<IdGenerator, IdGeneratorService>() {}

export const IdGeneratorLive = Layer.succeed(IdGenerator, {
  next: Effect.sync(() => uuidv7()),
});
