import { PassThrough } from "node:stream";
import { describe, expect, test, vi } from "vitest";
import { attachAppServer, createAppServer, runAppServerJsonl } from "../src/index.js";

describe("app server composition", () => {
  test("composes the canonical runtime from placement ports", async () => {
    const appServer = createAppServer({
      ports: {
        capabilities: async () => ({
          protocolVersion: "2026-08-06",
          placement: "local",
          methods: [],
          features: {
            streamingEvents: true,
            interruption: true,
            approvals: true,
            userInput: true,
            compaction: true,
            harnessInspection: true,
            harnessValidation: true,
            immutableHarnessAdmission: true,
          },
          tools: [],
          toolCatalogHash: "catalog-hash",
        }),
        createThread: async (payload) => payload,
        readThread: async (threadId) => ({ id: threadId }),
        listTurns: async () => [],
        listEvents: async () => [],
        startTurn: async (_threadId, payload) => payload,
        isTurnActive: () => false,
        waitForTurnSettlement: async () => undefined,
        interruptTurn: async (threadId) => ({ threadId, interrupted: true }),
        resolveApproval: async (approvalId) => ({ approvalId }),
        inspectHarness: async () => ({ valid: true }),
        validateHarness: async () => ({ valid: true }),
        updateHarnessBackgroundReview: async (payload) => payload,
        diffHarness: async (payload) => payload,
        rollbackHarness: async (payload) => payload,
        reviewHarnessProposal: async (payload) => payload,
      },
    });

    await expect(appServer.runtime.threadRead({ threadId: "thread-1" })).resolves.toEqual({
      thread: { id: "thread-1" },
      turns: [],
      events: [],
    });
  });

  test("owns JSONL shutdown exactly once", async () => {
    const close = vi.fn(async () => undefined);
    const readable = new PassThrough();
    const writable = new PassThrough();
    readable.end();

    await runAppServerJsonl({
      appServer: attachAppServer({ runtime: runtimeStub(), close }),
      readable,
      writable,
    });

    expect(close).toHaveBeenCalledTimes(1);
  });
});

function runtimeStub() {
  return {
    capabilities: async () => ({}),
    threadStart: async () => ({}),
    threadResume: async () => ({}),
    threadRead: async () => ({}),
    turnStart: async () => ({}),
    turnSteer: async () => ({}),
    turnInterrupt: async () => ({}),
    approvalResolve: async () => ({}),
    userInputResolve: async () => ({}),
    harnessInspect: async () => ({}),
    harnessValidate: async () => ({}),
    harnessBackgroundReview: async () => ({}),
    harnessDiff: async () => ({}),
    harnessRollback: async () => ({}),
    harnessReview: async () => ({}),
  };
}
