#!/usr/bin/env bun
/**
 * Notifications worker (P6.T2) — the Render cron entrypoint (render.yaml
 * `ksbackend-notifications`). One pass:
 *
 *   1. scan confirmed appointments entering their 24h/1h reminder windows and
 *      enqueue outbox rows — dedup-keyed, so racing passes can never
 *      double-enqueue (UNIQUE index + ON CONFLICT DO NOTHING);
 *   2. drain the outbox: claim due rows (FOR UPDATE SKIP LOCKED) and deliver
 *      them through the email/push/SMS channel registry.
 *
 * Runs the SAME production layer graph as the web service (src/runtime.ts —
 * real drivers). Without channel credentials sends fail per call with
 * not_configured and the outbox retries on its backoff; boot stays green.
 * Exit code mirrors the pass: 0 = the pass ran to completion (even with
 * failed sends — those are recorded, visible outbox rows), 1 = the pass
 * itself crashed (Render marks the run failed; the next tick heals it).
 *
 * Reads env directly (edge script, same as migrate.ts/seed.ts).
 */
import { Effect, Exit } from "effect";

import { AppConfig } from "../src/infra/config";
import { ReminderScheduler } from "../src/modules/reminder/reminder.service";
import { makeRuntime } from "../src/runtime";

const { appEnv } = await Effect.runPromise(AppConfig);
const runtime = makeRuntime(appEnv);

const exit = await runtime.runPromiseExit(
  Effect.flatMap(ReminderScheduler, (service) => service.run()),
);
await runtime.dispose();

if (Exit.isSuccess(exit)) {
  const summary = exit.value;
  console.log(
    `[notifications] pass complete — scan=${summary.scanned} enqueued=${summary.enqueued} ` +
      `duplicates=${summary.duplicates} skipped=${summary.skipped} ` +
      `drain(claimed=${summary.drain.claimed} sent=${summary.drain.sent} ` +
      `failed=${summary.drain.failed} dead=${summary.drain.dead})`,
  );
} else {
  console.error("[notifications] worker pass crashed", exit.cause);
  process.exitCode = 1;
}
