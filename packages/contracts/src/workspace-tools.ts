import { z } from "zod";

export const WorkspaceTemplateConfigViewSchema = z
  .object({
    appId: z.string(),
    exists: z.boolean(),
    configPath: z.string().nullable().optional(),
    envVar: z.string().nullable(),
    toolName: z.string().nullable(),
    version: z.union([z.string(), z.number()]).nullable(),
    source: z.enum(["hosted_env", "local_file", "defaults", "missing"]),
    currentConfig: z.record(z.string(), z.unknown()).nullable(),
    defaults: z.record(z.string(), z.unknown()).nullable(),
    schema: z.record(z.string(), z.unknown()).nullable(),
    error: z.string().nullable().optional(),
    updatedAt: z.string(),
  })
  .passthrough();

export type WorkspaceTemplateConfigView = z.infer<typeof WorkspaceTemplateConfigViewSchema>;

export const WorkspaceToolNameSchema = z.enum([
  "create_sandbox_template_scaffold",
  "resource_read",
  "resource_search",
  "list_files",
  "read_files",
  "search_files",
  "preview_write_files",
  "preview_write_file",
  "preview_edit_file",
  "preview_delete_file",
  "write_files",
  "write_file",
  "edit_file",
  "delete_file",
  "workspace_status",
  "validate_sandbox_template",
  "build_sandbox_template",
  "run_sandbox_template",
  "git_init",
  "git_status",
  "git_diff",
  "git_fetch",
  "git_commit",
  "git_push",
  "publish_openpond_repo",
  "sandbox_create",
  "sandbox_templates",
  "sandbox_template_launch",
  "sandbox_status",
  "sandbox_list_files",
  "sandbox_read_file",
  "sandbox_search_files",
  "sandbox_upload_file",
  "sandbox_write_file",
  "sandbox_edit_file",
  "sandbox_delete_file",
  "sandbox_mkdir",
  "sandbox_move_file",
  "sandbox_exec",
  "sandbox_git_status",
  "sandbox_git_diff",
  "sandbox_git_export_patch",
  "sandbox_git_branch",
  "sandbox_git_commit",
  "sandbox_git_pull",
  "sandbox_git_push",
  "sandbox_preserve_source",
  "sandbox_promote_source",
  "sandbox_run_action",
  "sandbox_open_port",
  "sandbox_snapshot_catalog",
  "sandbox_snapshot_create",
  "sandbox_snapshot_update",
  "sandbox_snapshot_validate",
  "sandbox_snapshot_publish",
  "sandbox_replays",
  "sandbox_replay_start",
  "sandbox_replay_get",
  "sandbox_replay_logs",
  "sandbox_replay_artifacts",
  "sandbox_replay_cancel",
  "sandbox_logs",
  "sandbox_receipts",
  "sandbox_schedule_create",
  "sandbox_stop",
]);

export type WorkspaceToolName = z.infer<typeof WorkspaceToolNameSchema>;

export const WorkspaceToolRequestSchema = z.object({
  action: WorkspaceToolNameSchema,
  args: z.record(z.string(), z.unknown()).optional().default({}),
  source: z.enum(["ui_button", "chat_action", "terminal_command", "hook"]).default("chat_action"),
});

export type WorkspaceToolRequest = z.infer<typeof WorkspaceToolRequestSchema>;

export const WorkspaceToolResultSchema = z.object({
  ok: z.boolean(),
  action: WorkspaceToolNameSchema,
  appId: z.string().nullable().optional(),
  output: z.string(),
  data: z.unknown().optional(),
});

export type WorkspaceToolResult = z.infer<typeof WorkspaceToolResultSchema>;
