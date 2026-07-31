import { createHash } from "node:crypto";
import { describe, expect, test } from "vitest";
import type {
  Session,
  WorkspaceToolRequest,
  WorkspaceToolResult,
} from "@openpond/contracts";
import {
  createWorkRuntimeService,
  WORK_ENVIRONMENT_PROBE,
  WORK_RESET_COMMAND,
  waitForWorkReceiptSettlement,
} from "./work-runtime-service.js";

describe("Work runtime service", () => {
  test("shares one lazy sandbox, verifies inputs, and stops stale session snapshots", async () => {
    const calls: WorkspaceToolRequest[] = [];
    const bytes = Buffer.from("sku,count\nA,2\n", "utf8");
    const runtime = createWorkRuntimeService({
      inputs: [{
        storageName: "inventory.csv",
        bytes,
        sha256: createHash("sha256").update(bytes).digest("hex"),
        sizeBytes: bytes.byteLength,
      }],
      executeWorkspaceTool: async (_sessionId, payload) => {
        const request = payload as WorkspaceToolRequest;
        calls.push(request);
        return result(
          request,
          request.action === "sandbox_status"
            ? { sandbox: { id: "sandbox_1", state: "running" } }
            : {},
        );
      },
    });
    const context = { session: workSession(), turnId: "turn_1" };

    await Promise.all([
      runtime.ensureReady(context),
      runtime.ensureReady(context),
    ]);
    await runtime.reset(context);
    const stopped = await runtime.stop(context);

    expect(calls.filter((call) => call.action === "sandbox_create")).toHaveLength(1);
    expect(calls.filter((call) => call.action === "sandbox_upload_file"))
      .toHaveLength(2);
    expect(calls).toContainEqual(expect.objectContaining({
      action: "sandbox_exec",
      args: expect.objectContaining({
        command: WORK_RESET_COMMAND,
      }),
    }));
    expect(calls.at(-1)?.action).toBe("sandbox_stop");
    expect(stopped.ok).toBe(true);
  });

  test("uses absolute Work paths so commands survive a resumed runtime cwd", () => {
    expect(WORK_ENVIRONMENT_PROBE).toMatch(/^cd \/workspace\/work && /);
    expect(WORK_RESET_COMMAND).toContain(
      "find /workspace/inputs /workspace/work /workspace/outputs",
    );
  });

  test("rejects an input whose bytes do not match the immutable manifest", async () => {
    const calls: WorkspaceToolRequest[] = [];
    const runtime = createWorkRuntimeService({
      inputs: [{
        storageName: "inventory.csv",
        bytes: Buffer.from("changed", "utf8"),
        sha256: "a".repeat(64),
        sizeBytes: 7,
      }],
      executeWorkspaceTool: async (_sessionId, payload) => {
        const request = payload as WorkspaceToolRequest;
        calls.push(request);
        return result(
          request,
          request.action === "sandbox_status"
            ? { sandbox: { id: "sandbox_1", state: "running" } }
            : {},
        );
      },
    });

    await expect(runtime.ensureReady({
      session: workSession(),
      turnId: "turn_1",
    })).rejects.toThrow("hash does not match");
    expect(calls.some((call) => call.action === "sandbox_upload_file")).toBe(false);
    expect(calls.at(-1)?.action).toBe("sandbox_stop");
  });

  test("waits until a captured sandbox receipt is available", async () => {
    let reads = 0;
    let elapsed = 0;
    const settled = await waitForWorkReceiptSettlement(
      async () => {
        reads += 1;
        return {
          ok: true,
          action: "sandbox_receipts",
          output: "ok",
          data: {
            receipts: reads < 3
              ? [{ id: "receipt_1", status: "pending" }]
              : [{
                  id: "receipt_1",
                  status: "captured",
                  totalUsd: "0.002500",
                  durationSeconds: 8,
                }],
          },
        };
      },
      {
        timeoutMs: 1_000,
        pollMs: 100,
        now: () => elapsed,
        sleep: async (milliseconds) => {
          elapsed += milliseconds;
        },
      },
    );

    expect(reads).toBe(3);
    expect(settled.data).toEqual({
      receipts: [{
        id: "receipt_1",
        status: "captured",
        totalUsd: "0.002500",
        durationSeconds: 8,
      }],
    });
  });
});

function result(
  request: WorkspaceToolRequest,
  data: Record<string, unknown>,
): WorkspaceToolResult {
  return {
    ok: true,
    action: request.action,
    output: "ok",
    data,
  };
}

function workSession(): Session {
  return {
    id: "work_task_1",
    experience: "work",
    provider: "openpond",
    modelRef: null,
    openPondCommandAccessMode: "disabled",
    systemKind: null,
    hiddenFromDefaultSidebar: true,
    parentSessionId: null,
    parentTurnId: null,
    subagentRunId: null,
    subagentRoleId: null,
    subagentDelegationMode: null,
    title: "Automated Work attempt",
    appId: null,
    appName: null,
    workspaceKind: undefined,
    workspaceId: null,
    workspaceName: null,
    localProjectId: null,
    cloudProjectId: null,
    cloudTeamId: null,
    currentProfile: null,
    cwd: null,
    codexThreadId: null,
    createdAt: "2026-07-30T00:00:00.000Z",
    updatedAt: "2026-07-30T00:00:00.000Z",
    status: "idle",
    runtimeSeconds: 0,
    runtimeRunningSince: null,
    pinned: false,
    savedForLater: false,
    archived: false,
    order: 0,
  };
}
