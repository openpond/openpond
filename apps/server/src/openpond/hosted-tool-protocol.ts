import {
  WorkspaceToolRequestSchema,
  type WorkspaceToolName,
  type WorkspaceToolRequest,
  type WorkspaceToolResult,
} from "@openpond/contracts";

const MAX_TOOL_RESULT_CHARS = 20000;
const MODEL_HIDDEN_DATA_KEYS = new Set(["remoteUrl", "repoPath", "workspacePath", "expectedRemoteUrl"]);

type RequiredArgType = "nonEmptyString" | "string" | "stringArray" | "stringRecord" | "record";

type RequiredArg = {
  key: string;
  type: RequiredArgType;
  description: string;
};

export type WorkspaceToolValidationIssue = {
  path: string;
  message: string;
  expected: string;
};

const REQUIRED_ARGS_BY_ACTION: Partial<Record<WorkspaceToolName, RequiredArg[]>> = {
  resource_read: [
    { key: "ref", type: "nonEmptyString", description: "resource ref such as workspace:file:package.json" },
  ],
  resource_search: [
    { key: "scope", type: "nonEmptyString", description: "resource scope such as workspace" },
    { key: "query", type: "nonEmptyString", description: "search text or path fragment" },
  ],
  read_files: [
    { key: "paths", type: "stringArray", description: "one or more workspace-relative file paths" },
  ],
  search_files: [
    { key: "query", type: "nonEmptyString", description: "search text or regex" },
  ],
  preview_write_file: [
    { key: "path", type: "nonEmptyString", description: "workspace-relative file path" },
    { key: "content", type: "string", description: "complete file contents" },
  ],
  write_file: [
    { key: "path", type: "nonEmptyString", description: "workspace-relative file path" },
    { key: "content", type: "string", description: "complete file contents" },
  ],
  preview_write_files: [
    { key: "files", type: "stringRecord", description: "object mapping workspace-relative paths to complete file contents" },
  ],
  write_files: [
    { key: "files", type: "stringRecord", description: "object mapping workspace-relative paths to complete file contents" },
  ],
  preview_edit_file: [
    { key: "path", type: "nonEmptyString", description: "workspace-relative file path" },
    { key: "oldText", type: "nonEmptyString", description: "exact text currently in the file" },
    { key: "newText", type: "string", description: "replacement text; use an empty string only for deletion" },
  ],
  edit_file: [
    { key: "path", type: "nonEmptyString", description: "workspace-relative file path" },
    { key: "oldText", type: "nonEmptyString", description: "exact text currently in the file" },
    { key: "newText", type: "string", description: "replacement text; use an empty string only for deletion" },
  ],
  preview_delete_file: [
    { key: "path", type: "nonEmptyString", description: "workspace-relative file path" },
  ],
  delete_file: [
    { key: "path", type: "nonEmptyString", description: "workspace-relative file path" },
  ],
  git_commit: [
    { key: "message", type: "nonEmptyString", description: "commit message" },
  ],
  sandbox_read_file: [
    { key: "path", type: "nonEmptyString", description: "sandbox file path" },
  ],
  sandbox_search_files: [
    { key: "query", type: "nonEmptyString", description: "search text or regex" },
  ],
  sandbox_write_file: [
    { key: "path", type: "nonEmptyString", description: "sandbox file path" },
    { key: "content", type: "string", description: "complete file contents" },
  ],
  sandbox_edit_file: [
    { key: "path", type: "nonEmptyString", description: "sandbox file path" },
    { key: "oldText", type: "nonEmptyString", description: "exact text currently in the sandbox file" },
    { key: "newText", type: "string", description: "replacement text; use an empty string only for deletion" },
  ],
  sandbox_delete_file: [
    { key: "path", type: "nonEmptyString", description: "sandbox file path" },
  ],
  sandbox_mkdir: [
    { key: "path", type: "nonEmptyString", description: "sandbox directory path" },
  ],
  sandbox_move_file: [
    { key: "fromPath", type: "nonEmptyString", description: "sandbox source path" },
    { key: "toPath", type: "nonEmptyString", description: "sandbox target path" },
  ],
  sandbox_exec: [
    { key: "command", type: "nonEmptyString", description: "bounded shell command to run in the sandbox" },
  ],
  sandbox_git_branch: [
    { key: "branch", type: "nonEmptyString", description: "sandbox git branch name" },
  ],
  sandbox_git_commit: [
    { key: "message", type: "nonEmptyString", description: "sandbox git commit message" },
  ],
  sandbox_run_action: [
    { key: "actionName", type: "nonEmptyString", description: "YAML action name from the project or agent registry" },
  ],
  sandbox_snapshot_create: [
    { key: "name", type: "nonEmptyString", description: "snapshot name" },
  ],
  sandbox_snapshot_update: [
    { key: "snapshotId", type: "nonEmptyString", description: "snapshot id" },
  ],
  sandbox_snapshot_validate: [
    { key: "snapshotId", type: "nonEmptyString", description: "snapshot id" },
  ],
  sandbox_snapshot_publish: [
    { key: "snapshotId", type: "nonEmptyString", description: "snapshot id" },
  ],
  sandbox_replay_start: [
    { key: "snapshotId", type: "nonEmptyString", description: "published replayable snapshot id" },
  ],
  sandbox_replay_get: [
    { key: "replayId", type: "nonEmptyString", description: "sandbox replay run id" },
  ],
  sandbox_replay_logs: [
    { key: "replayId", type: "nonEmptyString", description: "sandbox replay run id" },
  ],
  sandbox_replay_artifacts: [
    { key: "replayId", type: "nonEmptyString", description: "sandbox replay run id" },
  ],
  sandbox_replay_cancel: [
    { key: "replayId", type: "nonEmptyString", description: "sandbox replay run id" },
  ],
};

export const HOSTED_WORKSPACE_TOOL_PROTOCOL = [
  "Workspace tools are available through a strict text protocol.",
  "When you need to inspect or change the app workspace, respond with exactly one fenced block labelled openpond_tool and no other prose.",
  "The block must contain JSON: {\"action\":\"read_files\",\"args\":{\"paths\":[\"package.json\"]}}.",
  "Available actions: create_sandbox_template_scaffold, resource_search, resource_read, workspace_status, list_files, read_files, search_files, preview_write_files, preview_write_file, preview_edit_file, preview_delete_file, write_files, write_file, edit_file, delete_file, validate_sandbox_template, build_sandbox_template, run_sandbox_template, git_init, git_status, git_fetch, git_commit, git_push, publish_openpond_repo, sandbox_create, sandbox_templates, sandbox_template_launch, sandbox_status, sandbox_list_files, sandbox_read_file, sandbox_search_files, sandbox_upload_file, sandbox_write_file, sandbox_edit_file, sandbox_delete_file, sandbox_mkdir, sandbox_move_file, sandbox_exec, sandbox_git_status, sandbox_git_diff, sandbox_git_export_patch, sandbox_git_branch, sandbox_git_commit, sandbox_git_pull, sandbox_git_push, sandbox_preserve_source, sandbox_promote_source, sandbox_run_action, sandbox_open_port, sandbox_snapshot_catalog, sandbox_snapshot_create, sandbox_snapshot_update, sandbox_snapshot_validate, sandbox_snapshot_publish, sandbox_replays, sandbox_replay_start, sandbox_replay_get, sandbox_replay_logs, sandbox_replay_artifacts, sandbox_replay_cancel, sandbox_logs, sandbox_receipts, sandbox_stop.",
  "Required args: resource_search {scope, query}; resource_read {ref}; read_files {paths}; search_files {query}; write_file/preview_write_file {path, content}; write_files/preview_write_files {files}; edit_file/preview_edit_file {path, oldText, newText}; delete_file/preview_delete_file {path}; git_commit {message}; run_sandbox_template {optional mode/target/params/uploads/sandboxId}; sandbox_create {optional repo/teamId/projectId/agentId/command/visibility/resources/budget/quotas/metadata/runtime/workflowMode/runtimeProfileId/runtimeBaseBranch/runtimePromotionPolicy/attachToSession}; sandbox_templates {optional teamId/projectId/q/name/version/tag/useCase}; sandbox_template_launch {snapshotId or templateName or useCase, optional teamId/projectId/version/visibility/resources/budget/quotas/metadata/attachToSession}; sandbox_read_file {path, optional sandboxId}; sandbox_search_files {query, optional sandboxId}; sandbox_upload_file {path, contentsBase64, optional sandboxId}; sandbox_write_file {path, content, optional sandboxId}; sandbox_edit_file {path, oldText, newText, optional sandboxId}; sandbox_delete_file {path, optional recursive/sandboxId}; sandbox_mkdir {path, optional recursive/sandboxId}; sandbox_move_file {fromPath, toPath, optional overwrite/sandboxId}; sandbox_exec {command, optional sandboxId}; sandbox_git_export_patch {optional baseRef/sandboxId}; sandbox_git_branch {branch, optional create/startPoint/sandboxId}; sandbox_git_commit {message, optional all/paths/sandboxId}; sandbox_preserve_source {optional message/runtimeId/sandboxId}; sandbox_promote_source {optional expectedTargetSha/runtimeId/sandboxId}; sandbox_run_action {actionName, optional sandboxId/projectId/agentId/input}; sandbox_open_port {port, optional sandboxId}; sandbox_snapshot_create {name, optional sandboxId/template/replay}; sandbox_snapshot_update/validate/publish {snapshotId, optional sandboxId}; sandbox_replay_start {snapshotId, optional teamId/projectId/entrypoint/params/budget/artifactPaths}; sandbox_replay_get/logs/artifacts/cancel {replayId}.",
  "Prefer resource_search with scope workspace to find candidate files, then resource_read on returned refs to inspect stable, metadata-rich resources with explicit truncation. Use read_files only when you already know exact paths and need raw file contents.",
  "For edit_file and sandbox_edit_file, oldText must exactly match existing file text. For targeted edits, include enough surrounding context for oldText to match exactly once; multi-match edits fail unless args.replaceAll is true. If you are not certain, call read_files or sandbox_read_file first.",
  "Use write_files for multi-file edits so validation/build runs once after the batch.",
  "Local write, edit, and delete actions return a pre-write diff preview plus validation/build results. Sandbox file actions return sandbox API read/write/delete results.",
  "If a tool result has ok:false, inspect its output/data and repair the specific issue before trying to commit, push, or deploy.",
  "Use sandbox_create to create or resume a sandbox runtime-backed remote sandbox from chat. When projectId or agentId is provided, sandbox_create reuses that project's or agent's default sandbox runtime unless args.runtime.runtimeId selects a specific runtime. Use sandbox_templates to find published project templates, and sandbox_template_launch to start from a published template. Use sandbox_edit_file for exact text edits after reading the sandbox file. Use sandbox_git_export_patch to export a portable patch, sandbox_preserve_source to commit active changes back to the runtime source ref, and sandbox_promote_source only when the user asks to apply the preserved source ref to the Project branch. Use sandbox_run_action to execute a named action from openpond.yaml; when projectId or agentId is provided and args.sandboxId is omitted, sandbox_run_action starts a detached sandbox for that project or agent and then runs the action. By default, sandbox_create or sandbox_template_launch binds the chat session to that sandbox workspace; set args.attachToSession false for one-off tool-style execution that should leave the current chat scope unchanged.",
  "Use sandbox_snapshot_create, sandbox_snapshot_validate, and sandbox_snapshot_publish when the user asks to preserve a sandbox as a replayable or launchable template. Use sandbox_replay_start and replay read/log/artifact tools for durable runs that should survive sandbox cleanup.",
  "When the active workspace is a sandbox, use only sandbox_* actions for workspace inspection, file changes, commands, previews, logs, receipts, and stopping compute.",
  "When you finish after workspace actions, answer in a concise Codex-style markdown format: brief outcome first, then Changed Files when files changed, then Verification when checks ran.",
  "Do not use emojis in responses, generated prompts, templates, profile text, comments, or sample output unless the user explicitly asks for them.",
  "Do not mention raw tool JSON, internal repo paths, or origin/remote URLs unless the user explicitly asks for those details or they are necessary to explain a git/deploy failure.",
  "After a tool result is returned, either request the next tool the same way or answer the user normally.",
].join("\n");

function truncate(value: string): string {
  if (value.length <= MAX_TOOL_RESULT_CHARS) return value;
  return `${value.slice(0, MAX_TOOL_RESULT_CHARS)}\n\n[tool result truncated]`;
}

function parseToolPayload(raw: string): WorkspaceToolRequest[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw.trim());
  } catch {
    return [];
  }

  const candidates: unknown[] =
    Array.isArray(parsed)
      ? parsed
      : parsed && typeof parsed === "object" && Array.isArray((parsed as Record<string, unknown>).tools)
        ? ((parsed as Record<string, unknown>).tools as unknown[])
        : [parsed];

  const requests: WorkspaceToolRequest[] = [];
  for (const candidate of candidates) {
    const result = WorkspaceToolRequestSchema.safeParse(candidate);
    if (result.success) requests.push(result.data);
  }
  return requests;
}

export function extractWorkspaceToolRequests(text: string): WorkspaceToolRequest[] {
  const requests: WorkspaceToolRequest[] = [];
  const seen = new Set<string>();
  const add = (items: WorkspaceToolRequest[]) => {
    for (const item of items) {
      const key = JSON.stringify(item);
      if (seen.has(key)) continue;
      seen.add(key);
      requests.push(item);
    }
  };

  for (const match of text.matchAll(/```(?:openpond_tool|openpond-tools|openpond_tool_call|json)\s*([\s\S]*?)```/gi)) {
    add(parseToolPayload(match[1] ?? ""));
  }
  for (const match of text.matchAll(/<openpond_tool>([\s\S]*?)<\/openpond_tool>/gi)) {
    add(parseToolPayload(match[1] ?? ""));
  }
  for (const match of text.matchAll(/<json>([\s\S]*?)<\/json>/gi)) {
    add(parseToolPayload(match[1] ?? ""));
  }

  const trimmed = text.trim();
  if (requests.length === 0 && (trimmed.startsWith("{") || trimmed.startsWith("["))) {
    add(parseToolPayload(trimmed));
  }

  return requests;
}

function expectedText(arg: RequiredArg): string {
  if (arg.type === "nonEmptyString") return `${arg.key}: non-empty string (${arg.description})`;
  if (arg.type === "string") return `${arg.key}: string (${arg.description})`;
  if (arg.type === "stringArray") return `${arg.key}: non-empty array of strings (${arg.description})`;
  if (arg.type === "stringRecord") return `${arg.key}: non-empty object of string values (${arg.description})`;
  return `${arg.key}: non-empty object (${arg.description})`;
}

function issueFor(arg: RequiredArg, message: string): WorkspaceToolValidationIssue {
  return { path: `args.${arg.key}`, message, expected: expectedText(arg) };
}

function validateArg(args: Record<string, unknown>, arg: RequiredArg): WorkspaceToolValidationIssue | null {
  const value = args[arg.key];
  if (arg.type === "nonEmptyString") {
    if (typeof value !== "string" || !value.trim()) return issueFor(arg, `${arg.key} is required`);
    return null;
  }
  if (arg.type === "string") {
    if (typeof value !== "string") return issueFor(arg, `${arg.key} must be a string`);
    return null;
  }
  if (arg.type === "stringArray") {
    if (!Array.isArray(value) || value.length === 0 || value.some((item) => typeof item !== "string" || !item.trim())) {
      return issueFor(arg, `${arg.key} must be a non-empty array of strings`);
    }
    return null;
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return issueFor(arg, arg.type === "record" ? `${arg.key} must be an object` : `${arg.key} must be an object of file paths to content strings`);
  }
  if (arg.type === "record") {
    return Object.keys(value).length > 0 ? null : issueFor(arg, `${arg.key} must not be empty`);
  }
  const entries = Object.entries(value);
  if (entries.length === 0 || entries.some(([filePath, content]) => !filePath.trim() || typeof content !== "string")) {
    return issueFor(arg, `${arg.key} must map one or more file paths to string content`);
  }
  return null;
}

function requiredArgsForWorkspaceTool(action: WorkspaceToolName): string[] {
  return (REQUIRED_ARGS_BY_ACTION[action] ?? []).map(expectedText);
}

export function validateWorkspaceToolRequest(request: WorkspaceToolRequest): WorkspaceToolValidationIssue[] {
  const required = REQUIRED_ARGS_BY_ACTION[request.action] ?? [];
  const issues: WorkspaceToolValidationIssue[] = [];
  for (const arg of required) {
    const issue = validateArg(request.args, arg);
    if (issue) issues.push(issue);
  }
  return issues;
}

export function formatWorkspaceToolValidationErrorForModel(
  request: WorkspaceToolRequest,
  issues: WorkspaceToolValidationIssue[]
): string {
  const result: WorkspaceToolResult = {
    ok: false,
    action: request.action,
    output: [
      `Invalid ${request.action} tool request.`,
      issues.map((issue) => `${issue.path}: ${issue.message}; expected ${issue.expected}`).join(" "),
      "Retry with the required args. If you need exact file text for an edit, call read_files first.",
    ].join(" "),
    data: {
      validationError: true,
      issues,
      requiredArgs: requiredArgsForWorkspaceTool(request.action),
      receivedArgs: request.args,
    },
  };
  return formatWorkspaceToolResultForModel(result);
}

function dataForModel(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(dataForModel);
  if (!value || typeof value !== "object") return value;
  const output: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(value)) {
    if (MODEL_HIDDEN_DATA_KEYS.has(key)) continue;
    output[key] = dataForModel(child);
  }
  return output;
}

export function formatWorkspaceToolResultForModel(result: WorkspaceToolResult): string {
  return truncate(
    JSON.stringify(
      {
        ok: result.ok,
        action: result.action,
        appId: result.appId ?? null,
        output: result.output,
        data: dataForModel(result.data ?? null),
      },
      null,
      2
    )
  );
}
