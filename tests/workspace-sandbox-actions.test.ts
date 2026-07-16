import { describe, expect, test } from "vitest";
import { MUTATING_WORKSPACE_TOOL_ACTIONS } from "../apps/server/src/workspace-tools/workspace-tool-action-sets";
import {
  isSandboxSourceMutationAction,
  resolveSandboxSourcePreserveTeamId,
  sandboxSourceReadbackPatchFilePaths,
} from "../apps/server/src/workspace-tools/workspace-tool-sandbox-actions";

describe("sandbox workspace actions", () => {
  test("treats sandbox git source changes as preservable mutations", () => {
    expect(isSandboxSourceMutationAction("sandbox_git_branch")).toBe(true);
    expect(isSandboxSourceMutationAction("sandbox_git_commit")).toBe(true);
    expect(isSandboxSourceMutationAction("sandbox_git_pull")).toBe(true);
    expect(isSandboxSourceMutationAction("sandbox_git_push")).toBe(false);
    expect(isSandboxSourceMutationAction("sandbox_git_apply_patch_local")).toBe(false);
  });

  test("refreshes workspace diffs after sandbox git state changes", () => {
    expect(MUTATING_WORKSPACE_TOOL_ACTIONS).toContain("sandbox_git_branch");
    expect(MUTATING_WORKSPACE_TOOL_ACTIONS).toContain("sandbox_git_commit");
    expect(MUTATING_WORKSPACE_TOOL_ACTIONS).toContain("sandbox_git_pull");
    expect(MUTATING_WORKSPACE_TOOL_ACTIONS).toContain("sandbox_git_push");
    expect(MUTATING_WORKSPACE_TOOL_ACTIONS).toContain("sandbox_git_apply_patch_local");
  });

  test("preserves source with team context when sandbox mutation args only include sandbox id", () => {
    expect(
      resolveSandboxSourcePreserveTeamId({
        args: { sandboxId: "sandbox_1" },
        session: { cloudTeamId: "team_from_session" },
        result: { sandbox: { teamId: "team_from_result" } },
      }),
    ).toBe("team_from_session");

    expect(
      resolveSandboxSourcePreserveTeamId({
        args: { sandboxId: "sandbox_1" },
        session: { cloudTeamId: null },
        result: { sandbox: { teamId: "team_from_result" } },
      }),
    ).toBe("team_from_result");

    expect(
      resolveSandboxSourcePreserveTeamId({
        args: { sandboxId: "sandbox_1", teamId: "team_from_args" },
        session: { cloudTeamId: "team_from_session" },
        result: { sandbox: { teamId: "team_from_result" } },
      }),
    ).toBe("team_from_args");
  });

  test("extracts changed file paths for sandbox readback artifacts", () => {
    const patch = [
      "diff --git a/README.md b/README.md",
      "index 1111111..2222222 100644",
      "--- a/README.md",
      "+++ b/README.md",
      "@@ -1 +1 @@",
      "-old",
      "+new",
      "diff --git a/src/old.ts b/src/new.ts",
      "similarity index 80%",
      "rename from src/old.ts",
      "rename to src/new.ts",
    ].join("\n");

    expect(sandboxSourceReadbackPatchFilePaths(patch)).toEqual(["README.md", "src/new.ts"]);
  });
});
