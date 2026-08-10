import type { SqliteStore } from "../store/store.js";
import { loadSelectedLocalHarnessRuntime } from "../harness/local-harness-skill-runtime.js";
import { waitForWorkReceiptSettlement } from "../openpond/work-runtime-service.js";
import { createBenchmarkTasksetService } from "./benchmark-tasksets.js";
import { createLocalTasksetWorkRuntime } from "./local-taskset-work-runtime.js";
import type { TasksetWorkAttemptRuntime } from "./taskset-work-attempt-runner.js";

export function createBenchmarkRuntimeComposition(input: {
  store: SqliteStore;
  storeDir: string;
  deviceId: string;
  createSession: TasksetWorkAttemptRuntime["createSession"];
  getSession: TasksetWorkAttemptRuntime["getSession"];
  executeWorkspaceTool: TasksetWorkAttemptRuntime["executeWorkspaceTool"];
}) {
  const tasksetWorkRuntime: TasksetWorkAttemptRuntime = {
    createSession: input.createSession,
    getSession: input.getSession,
    executeWorkspaceTool: input.executeWorkspaceTool,
    runtimeEventsForSession: (sessionId) =>
      input.store.runtimeEventsForSession(sessionId),
    settleCostEvidence: (sessionId, options) =>
      waitForWorkReceiptSettlement(() =>
        input.executeWorkspaceTool(
          sessionId,
          {
            action: "sandbox_receipts",
            args: {},
            source: "chat_action",
          },
          { turnId: options?.turnId },
        ),
      ),
  };
  const localTasksetWorkRuntime = createLocalTasksetWorkRuntime({
    storeDir: input.storeDir,
    deviceId: input.deviceId,
    createSession: input.createSession,
    getSession: input.getSession,
    runtimeEventsForSession: (sessionId) =>
      input.store.runtimeEventsForSession(sessionId),
  });
  const benchmarkTasksets = createBenchmarkTasksetService({
    store: input.store,
    storeDir: input.storeDir,
  });
  const resolveReleasedHarness = async () => {
    const runtime = await loadSelectedLocalHarnessRuntime(input.store);
    return runtime
      ? {
          agentSnapshot: runtime.release.agentSnapshot,
          harnessRelease: runtime.release.harnessRelease,
          instructionContext: runtime.instructionContext,
        }
      : null;
  };
  return {
    benchmarkTasksets,
    localTasksetWorkRuntime,
    resolveReleasedHarness,
    tasksetWorkRuntime,
  };
}
