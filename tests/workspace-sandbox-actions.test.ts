import { describe, expect, test } from "bun:test";
import { MUTATING_WORKSPACE_TOOL_ACTIONS } from "../apps/server/src/workspace-tools/workspace-tool-action-sets";
import {
  isSandboxSourceMutationAction,
  resolveSandboxSourcePreserveTeamId,
} from "../apps/server/src/workspace-tools/workspace-tool-sandbox-actions";

describe("sandbox workspace actions", () => {
  test("treats sandbox git source changes as preservable mutations", () => {
    expect(isSandboxSourceMutationAction("sandbox_git_branch")).toBe(true);
    expect(isSandboxSourceMutationAction("sandbox_git_commit")).toBe(true);
    expect(isSandboxSourceMutationAction("sandbox_git_pull")).toBe(true);
    expect(isSandboxSourceMutationAction("sandbox_git_push")).toBe(false);
  });

  test("refreshes workspace diffs after sandbox git state changes", () => {
    expect(MUTATING_WORKSPACE_TOOL_ACTIONS).toContain("sandbox_git_branch");
    expect(MUTATING_WORKSPACE_TOOL_ACTIONS).toContain("sandbox_git_commit");
    expect(MUTATING_WORKSPACE_TOOL_ACTIONS).toContain("sandbox_git_pull");
    expect(MUTATING_WORKSPACE_TOOL_ACTIONS).toContain("sandbox_git_push");
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
});
