import type { RuntimeEvent, Session, SubagentRoleSettings, WorkspaceToolRequest } from "@openpond/contracts";
import { recordFromUnknown } from "../turns/value-utils.js";

export const RESOURCE_TEXT_FALLBACK_ACTIONS = new Set<
  WorkspaceToolRequest["action"]
>(["resource_search", "resource_read"]);

export const READ_ONLY_SUBAGENT_WORKSPACE_TOOL_ACTIONS = new Set<
  WorkspaceToolRequest["action"]
>([
  "resource_search",
  "resource_read",
  "workspace_status",
  "list_files",
  "read_files",
  "search_files",
  "git_status",
  "git_diff",
  "sandbox_status",
  "sandbox_list_files",
  "sandbox_read_file",
  "sandbox_search_files",
  "sandbox_git_status",
  "sandbox_git_diff",
  "sandbox_git_export_patch",
  "sandbox_snapshot_catalog",
  "sandbox_templates",
  "sandbox_replays",
  "sandbox_replay_get",
  "sandbox_replay_logs",
  "sandbox_replay_artifacts",
  "sandbox_logs",
  "sandbox_receipts",
]);

export const PARENT_MODEL_VISIBLE_SUBAGENT_EVENTS = new Set<
  RuntimeEvent["name"]
>(["subagent.message"]);

export function subagentWorkspaceToolPolicyBlocker(
  session: Session,
  request: WorkspaceToolRequest
): string | null {
  const policy = subagentToolPolicyForSession(session);
  if (policy !== "read_only") return null;
  if (READ_ONLY_SUBAGENT_WORKSPACE_TOOL_ACTIONS.has(request.action))
    return null;
  return [
    `Workspace action ${request.action} is blocked by the read_only subagent tool policy.`,
    "Use read/search/status/diff tools only, or report that this child assignment needs a write-capable isolated workspace.",
  ].join(" ");
}

function subagentToolPolicyForSession(
  session: Session
): SubagentRoleSettings["toolPolicy"] | null {
  if (!session.subagentRunId) return null;
  const subagent = recordFromUnknown(
    recordFromUnknown(session.metadata)?.subagent
  );
  const toolPolicy =
    typeof subagent?.toolPolicy === "string" ? subagent.toolPolicy : null;
  if (
    toolPolicy === "read_only" ||
    toolPolicy === "workspace_write" ||
    toolPolicy === "full_tools"
  )
    return toolPolicy;
  return "read_only";
}
