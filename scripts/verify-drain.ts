#!/usr/bin/env bun
/**
 * Manual verification for P0.T4 (run with `bun scripts/verify-drain.ts`, needs
 * the Bun runtime — vitest runs under Node, where Bun.serve does not exist).
 *
 * Proves the drain step of gracefulShutdown: Bun's `stop()` without
 * `closeActiveConnections` lets an in-flight request finish even after the
 * server stopped accepting new connections. Exits 0 on success, 1 on failure.
 */
import { gracefulShutdown } from "../src/infra/shutdown";

let release!: () => void;
const gated = new Promise<void>((resolve) => {
  release = resolve;
});
let started = false;

const server = Bun.serve({
  port: 0,
  fetch: async () => {
    started = true;
    await gated;
    return new Response("ok");
  },
});

const inFlight = fetch(`http://localhost:${server.port}/`);
await Bun.sleep(50);
if (!started) {
  console.error("FAIL: request never reached the gated handler");
  process.exit(1);
}

// Stop accepting connections while the request is still in flight.
const drain = gracefulShutdown({
  setReady: () => {},
  server,
  disposeRuntime: async () => {},
  closeAuth: async () => {},
  exit: () => {},
});
release();

const response = await inFlight;
await drain;
server.stop(true);

if (response.status === 200) {
  console.log("PASS: in-flight request completed during the drain (status 200)");
} else {
  console.error(`FAIL: in-flight request got status ${response.status}`);
  process.exit(1);
}
