import { describe, expect, test } from "vitest";
import type { Session } from "@openpond/contracts";
import {
  requiresExistingSandboxWorkspace,
  shouldUseSelectedSessionForWorkspaceAction,
} from "../apps/web/src/hooks/useWorkspaceActions";
import { checkpointAndStopSandbox } from "../apps/web/src/components/chat/workspace-environment-actions";

function session(input: Partial<Session>): Session {
  return {
    id: "session_1",
    title: "Session",
    provider: "openpond",
    status: "idle",
    createdAt: "2026-07-05T00:00:00.000Z",
    updatedAt: "2026-07-05T00:00:00.000Z",
    ...input,
  } as Session;
}

describe("workspace action routing", () => {
  test("routes existing sandbox actions to the selected sandbox session", () => {
    const selectedSandbox = session({
      workspaceKind: "sandbox",
      workspaceId: "sandbox_123",
      localProjectId: "local_123",
    });

    expect(requiresExistingSandboxWorkspace("sandbox_git_export_patch")).toBe(true);
    expect(requiresExistingSandboxWorkspace("sandbox_git_apply_patch_local")).toBe(true);
    expect(requiresExistingSandboxWorkspace("sandbox_stop")).toBe(true);
    expect(shouldUseSelectedSessionForWorkspaceAction("sandbox_git_export_patch", selectedSandbox)).toBe(true);
    expect(shouldUseSelectedSessionForWorkspaceAction("sandbox_git_apply_patch_local", selectedSandbox)).toBe(true);
    expect(shouldUseSelectedSessionForWorkspaceAction("sandbox_stop", selectedSandbox)).toBe(true);
  });

  test("does not route existing sandbox actions to a local project session", () => {
    const selectedLocal = session({
      workspaceKind: "local_project",
      workspaceId: "local_123",
      localProjectId: "local_123",
    });

    expect(shouldUseSelectedSessionForWorkspaceAction("sandbox_git_export_patch", selectedLocal)).toBe(false);
  });

  test("does not treat sandbox creation as requiring an existing sandbox", () => {
    const selectedSandbox = session({
      workspaceKind: "sandbox",
      workspaceId: "sandbox_123",
    });

    expect(requiresExistingSandboxWorkspace("sandbox_create")).toBe(false);
    expect(shouldUseSelectedSessionForWorkspaceAction("sandbox_create", selectedSandbox)).toBe(false);
  });

  test("routes explicit runtime resume through the selected sandbox session", () => {
    const selectedSandbox = session({
      workspaceKind: "sandbox",
      workspaceId: "sandbox_123",
    });

    expect(
      shouldUseSelectedSessionForWorkspaceAction("sandbox_create", selectedSandbox, {
        runtime: { runtimeId: "runtime_123" },
      }),
    ).toBe(true);
  });

  test("checkpoint and stop still attempts guarded stop when preservation fails", async () => {
    const calls: string[] = [];
    await checkpointAndStopSandbox(async (action) => {
      calls.push(action);
      return {
        ok: action !== "sandbox_preserve_source",
        action,
        appId: null,
        output: action === "sandbox_preserve_source" ? "placement_stale" : "Stopped sandbox.",
      };
    });

    expect(calls).toEqual(["sandbox_preserve_source", "sandbox_stop"]);
  });
});
