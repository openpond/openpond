import { execFile } from "node:child_process";
import { realpath } from "node:fs/promises";
import { hostname } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import type { Session, TaskPeer } from "@openpond/contracts";
import { resolveWorkspaceExecutionTarget } from "../../workspace/workspace-execution-target.js";

const exec = promisify(execFile);
type WorkspaceIdentity = { host: string; checkout: string; repository: string | null };

/** Physical overlap is advisory. Project authorization is checked separately. */
export async function taskWorkspaceIdentity(session: Session): Promise<WorkspaceIdentity | null> {
  const target = resolveWorkspaceExecutionTarget({ session });
  if (target.target === "sandbox") return target.sandboxId
    ? { host: `sandbox:${session.cloudTeamId ?? ""}`, checkout: target.sandboxId, repository: null } : null;
  if (target.target !== "local" || !target.cwd) return null;
  const cwd = await realpath(target.cwd).catch(() => null);
  if (!cwd) return null;
  const git = await exec("git", ["rev-parse", "--show-toplevel", "--git-common-dir"], { cwd, timeout: 3000, maxBuffer: 16_000 }).catch(() => null);
  const [root, common] = git?.stdout.trim().split("\n") ?? [];
  return { host: hostname(), checkout: root ? await realpath(root).catch(() => cwd) : cwd,
    repository: common ? await realpath(path.resolve(cwd, common)).catch(() => null) : null };
}

export function workspaceRelationship(left: WorkspaceIdentity | null, right: WorkspaceIdentity | null): TaskPeer["workspaceRelationship"] {
  if (!left || !right || left.host !== right.host) return "project";
  if (left.checkout === right.checkout) return "same_checkout";
  if (left.repository && left.repository === right.repository) return "same_repository";
  return "project";
}
