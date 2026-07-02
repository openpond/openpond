import { WorkspaceToolResultSchema, type WorkspaceToolResult } from "@openpond/contracts";
import { loadOpenPondAccountContext } from "@openpond/runtime";
import {
  commitWorkspaceChanges,
  ensureWorkspaceGitRepository,
  fetchWorkspaceRemote,
  getWorkspaceGitStatus,
  pushWorkspaceBranch,
} from "./workspace-tools.js";
import { stringArg } from "./workspace-tool-arg-utils.js";
import type { ActiveWorkspaceActionContext } from "./workspace-tool-active-types.js";

export async function handleActiveWorkspaceGitAction(
  context: ActiveWorkspaceActionContext
): Promise<WorkspaceToolResult | null> {
  const { app, args, input, runChecks, runPostEditChecks, session, state, turnId } = context;

  switch (input.action) {
    case "git_init": {
      const branch = typeof args.branch === "string" && args.branch.trim() ? args.branch.trim() : "master";
      await ensureWorkspaceGitRepository(state.repoPath, branch);
      const status = await getWorkspaceGitStatus(state.repoPath);
      const project =
        session.workspaceKind === "local_project" && session.workspaceId
          ? await context.refreshLocalProjectWorkspace(session.workspaceId)
          : null;
      return WorkspaceToolResultSchema.parse({
        ok: true,
        action: input.action,
        appId: app.id,
        output: status.branch ? `Initialized Git repository on ${status.branch}.` : "Initialized Git repository.",
        data: { status, project },
      });
    }

    case "git_status": {
      const status = await getWorkspaceGitStatus(state.repoPath);
      return WorkspaceToolResultSchema.parse({
        ok: true,
        action: input.action,
        appId: app.id,
        output: status.dirty
          ? `Workspace has ${status.files.length} changed file${status.files.length === 1 ? "" : "s"}.`
          : "Workspace has no uncommitted changes.",
        data: status,
      });
    }

    case "git_fetch": {
      const context = await loadOpenPondAccountContext();
      const fetched = await fetchWorkspaceRemote(state.repoPath, context.token);
      return WorkspaceToolResultSchema.parse({
        ok: true,
        action: input.action,
        appId: app.id,
        output: fetched.status.diverged
          ? "Fetched origin; branch has diverged."
          : fetched.status.behind > 0
            ? `Fetched origin; branch is behind by ${fetched.status.behind} commit${fetched.status.behind === 1 ? "" : "s"}.`
            : "Fetched origin.",
        data: fetched,
      });
    }

    case "git_commit": {
      const checks = runChecks ? await runPostEditChecks(session, turnId, input.source, state.repoPath) : [];
      const checksOk = checks.length === 0 || checks.every((check) => check.ok);
      if (!checksOk) {
        return WorkspaceToolResultSchema.parse({
          ok: false,
          action: input.action,
          appId: app.id,
          output: "Validation/build failed; commit was not created.",
          data: { checks },
        });
      }
      const committed = await commitWorkspaceChanges(state.repoPath, stringArg(args, "message"), {
        includeUnstaged: args.includeUnstaged !== false,
      });
      return WorkspaceToolResultSchema.parse({
        ok: true,
        action: input.action,
        appId: app.id,
        output: committed.commitSha ? `Committed ${committed.commitSha.slice(0, 12)}.` : "Committed workspace changes.",
        data: { ...committed, checks },
      });
    }

    case "git_push": {
      const checks = runChecks ? await runPostEditChecks(session, turnId, input.source, state.repoPath) : [];
      const checksOk = checks.length === 0 || checks.every((check) => check.ok);
      if (!checksOk) {
        return WorkspaceToolResultSchema.parse({
          ok: false,
          action: input.action,
          appId: app.id,
          output: "Validation/build failed; push was not attempted.",
          data: { checks },
        });
      }
      const context = await loadOpenPondAccountContext();
      const pushed = await pushWorkspaceBranch(state.repoPath, context.token);
      return WorkspaceToolResultSchema.parse({
        ok: true,
        action: input.action,
        appId: app.id,
        output: `Pushed ${pushed.branch}.`,
        data: { ...pushed, checks },
      });
    }

    default:
      return null;
  }
}
