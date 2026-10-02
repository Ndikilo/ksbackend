import { describe, expect, it } from "vitest";
import { gracefulShutdown, type ShutdownDeps } from "./shutdown";

const recordingDeps = (calls: string[]): ShutdownDeps => ({
  setReady: (value) => calls.push(`setReady(${value})`),
  server: {
    stop: async () => {
      calls.push("stop");
    },
  },
  disposeRuntime: async () => {
    calls.push("disposeRuntime");
  },
  closeAuth: async () => {
    calls.push("closeAuth");
  },
  exit: (code) => calls.push(`exit(${code})`),
});

describe("gracefulShutdown", () => {
  it("runs readiness → stop accepting → runtime dispose → auth close → exit, in order", async () => {
    const calls: string[] = [];
    await gracefulShutdown(recordingDeps(calls));
    expect(calls).toStrictEqual([
      "setReady(false)",
      "stop",
      "disposeRuntime",
      "closeAuth",
      "exit(0)",
    ]);
  });
});
