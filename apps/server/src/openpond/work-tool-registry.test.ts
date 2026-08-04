import { describe, expect, test, vi } from "vitest";
import type { WorkspaceToolResult } from "@openpond/contracts";
import {
  createWorkModelToolDefinitions,
  waitForWorkSandboxReady,
} from "./work-tool-registry.js";

function statusResult(state: string, ok = true): WorkspaceToolResult {
  return {
    ok,
    action: "sandbox_status",
    output: ok ? `Sandbox is ${state}.` : "status_failed",
    data: {
      sandbox: {
        state,
      },
    },
  };
}

describe("waitForWorkSandboxReady", () => {
  test("emits chat-completions-compatible parameter schemas", () => {
    const definitions = createWorkModelToolDefinitions({
      executeWorkspaceTool: async () => ({
        ok: true,
        action: "sandbox_status",
        output: "ok",
      }),
    });

    for (const definition of definitions) {
      expect(JSON.stringify(definition.parameters)).not.toMatch(
        /"type":\s*\[/
      );
    }
  });

  test("hides model-owned save and stop tools when lifecycle is automatic", () => {
    const definitions = createWorkModelToolDefinitions({
      automaticLifecycle: true,
      executeWorkspaceTool: async () => ({
        ok: true,
        action: "sandbox_status",
        output: "ok",
      }),
    });

    expect(definitions.map((definition) => definition.name)).not.toContain(
      "work_save_output"
    );
    expect(definitions.map((definition) => definition.name)).not.toContain(
      "work_stop"
    );
    expect(definitions.map((definition) => definition.name)).toContain(
      "work_exec"
    );
  });

  test("returns immediately when the sandbox is already running", async () => {
    const readStatus = vi.fn(async () => statusResult("running"));
    const sleep = vi.fn(async () => undefined);

    const result = await waitForWorkSandboxReady(readStatus, { sleep });

    expect(result.data).toMatchObject({ sandbox: { state: "running" } });
    expect(readStatus).toHaveBeenCalledTimes(1);
    expect(sleep).not.toHaveBeenCalled();
  });

  test("waits through asynchronous creation before returning", async () => {
    const states = ["creating", "creating", "running"];
    const readStatus = vi.fn(async () => statusResult(states.shift() ?? ""));
    let now = 0;
    const sleep = vi.fn(async (milliseconds: number) => {
      now += milliseconds;
    });

    const result = await waitForWorkSandboxReady(readStatus, {
      now: () => now,
      pollMs: 1_000,
      timeoutMs: 10_000,
      sleep,
    });

    expect(result.data).toMatchObject({ sandbox: { state: "running" } });
    expect(readStatus).toHaveBeenCalledTimes(3);
    expect(sleep).toHaveBeenCalledTimes(2);
  });

  test("fails immediately for terminal startup states", async () => {
    await expect(
      waitForWorkSandboxReady(async () => statusResult("error"))
    ).rejects.toThrow("Work sandbox entered error during startup.");
  });

  test("preserves status request failures", async () => {
    await expect(
      waitForWorkSandboxReady(async () => statusResult("creating", false))
    ).rejects.toThrow("status_failed");
  });

  test("times out with the last observed state", async () => {
    let now = 0;

    await expect(
      waitForWorkSandboxReady(async () => statusResult("creating"), {
        now: () => now,
        pollMs: 1_000,
        timeoutMs: 2_000,
        sleep: async (milliseconds) => {
          now += milliseconds;
        },
      })
    ).rejects.toThrow(
      "Work sandbox did not become ready within 2000ms (last state: creating)."
    );
  });
});
