import type { Session } from "@openpond/contracts";

type SubagentWorkspaceSession = Pick<Session, "cwd" | "metadata" | "subagentRunId">;

export function subagentIsolatedWorkspaceRepoPath(session: SubagentWorkspaceSession): string | null {
  if (!session.subagentRunId) return null;
  const metadata = recordFromUnknown(session.metadata);
  const subagent = recordFromUnknown(metadata?.subagent);
  const workspace = recordFromUnknown(subagent?.workspace) ?? recordFromUnknown(metadata?.subagentWorkspace);
  const repoPath = stringValue(workspace?.repoPath) ?? stringValue(workspace?.worktreePath);
  return repoPath ?? null;
}

function recordFromUnknown(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function stringValue(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}
