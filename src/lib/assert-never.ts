/**
 * Exhaustiveness guard. Put this in the `default:`/`else` branch of a switch or
 * conditional over a discriminated union: the compiler fails if any union member
 * is left unhandled, and it throws if an impossible value is reached at runtime.
 *
 * See docs/conventions.md (exhaustiveness rule).
 */
export const assertNever = (value: never): never => {
  throw new Error(`Unhandled case: ${JSON.stringify(value)}`);
};
