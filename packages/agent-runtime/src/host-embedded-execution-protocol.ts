import { z } from "zod";

const id = z.string().trim().min(1).max(200);

/** Narrow child request surface; the host still rechecks tenant, lease, sandbox and action policy. */
export const HostedSandboxActionSchema = z.object({
  type: z.enum(["create", "get", "start", "stop", "exec", "open_port",
    "list_files", "download_file", "upload_file", "search_files", "delete_file",
    "stat_file", "mkdir", "move_file", "process_start", "process_get",
    "git_status", "git_diff", "git_export_patch", "git_branch", "git_commit",
    "git_pull", "git_push"]),
  sandboxId: id.optional(),
  payload: z.unknown().optional(),
  processId: id.optional(),
  failOnUnpreservedChanges: z.boolean().optional(),
}).strict().superRefine((action, context) => {
  if (action.type !== "create" && !action.sandboxId) {
    context.addIssue({ code: "custom", message: "Sandbox identity is required." });
  }
  if (action.type === "process_get" && !action.processId) {
    context.addIssue({ code: "custom", message: "Process identity is required." });
  }
});

export const HostedSandboxRequestParamsSchema = z.object({ action: HostedSandboxActionSchema }).strict();
export const HostedToolAuthorizationParamsSchema = z.object({
  sessionId: id, turnId: id, name: id,
}).strict();
