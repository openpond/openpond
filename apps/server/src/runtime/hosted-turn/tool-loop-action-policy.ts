import type { RuntimeEvent, WorkspaceToolRequest } from "@openpond/contracts";

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
