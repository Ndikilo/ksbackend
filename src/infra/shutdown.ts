/**
 * SIGTERM/SIGINT drain sequence (P0.T4), in this exact order:
 *
 *   1. `setReady(false)`  — /readyz flips to 503 so the platform stops routing.
 *   2. `server.stop()`    — stop ACCEPTING connections; Bun's stop() without
 *                           `closeActiveConnections` resolves only after
 *                           in-flight requests finish (the drain).
 *   3. `disposeRuntime()` — dispose the Effect runtime → app DB pool closed.
 *   4. `closeAuth()`      — better-auth's own node-postgres pool closed.
 *   5. `exit(0)`.
 *
 * Disposing pools only AFTER the drain is the point: in-flight requests never
 * run against closed connections.
 */
export type ShutdownDeps = {
  readonly setReady: (value: boolean) => void;
  // Structural view of Bun's Server — only `stop` is needed here.
  readonly server: {
    readonly stop: (closeActiveConnections?: boolean) => Promise<void> | void;
  };
  readonly disposeRuntime: () => Promise<void>;
  readonly closeAuth: () => Promise<void> | void;
  readonly exit: (code: number) => void;
};

export const gracefulShutdown = async (deps: ShutdownDeps): Promise<void> => {
  deps.setReady(false);
  await deps.server.stop();
  await deps.disposeRuntime();
  await deps.closeAuth();
  deps.exit(0);
};
