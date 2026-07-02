import { promises as fs } from "node:fs";
import path from "node:path";
import {
  OPENPOND_MANIFEST_FILE_NAME,
  type OpenPondApp,
  type OpenPondActionCatalogEntry,
  type RuntimeEvent,
  type Session,
} from "@openpond/contracts";
import type { HostedChatMessage } from "@openpond/cloud";
import { createContextUsageSnapshot } from "./context-usage.js";
import { HOSTED_WORKSPACE_TOOL_PROTOCOL } from "./hosted-tool-protocol.js";
import { buildPersonalizedSystemPrompt } from "./personalization.js";
import { event } from "../utils.js";

export type HostedTurnHelpers = {
  maybeCreateScaffoldForTurn(session: Session, turnId: string, prompt: string): Promise<Session>;
  hostedSystemPrompt(
    basePrompt: string,
    personalizationSoul: string,
    session: Session,
    options?: { mentionedApps?: OpenPondApp[]; openPondActionCatalog?: OpenPondActionCatalogEntry[] }
  ): Promise<string>;
  appendAssistantText(session: Session, turnId: string, text: string): Promise<void>;
  appendHostedContextUsage(input: {
    session: Session;
    turnId: string;
    provider: "openpond";
    model: string;
    messages: HostedChatMessage[];
    usage?: unknown;
    includeCompletion?: boolean;
  }): Promise<void>;
};

export function createHostedTurnHelpers(deps: {
  appendRuntimeEvent: (runtimeEvent: RuntimeEvent) => Promise<void>;
}): HostedTurnHelpers {
  const { appendRuntimeEvent } = deps;

  async function maybeCreateScaffoldForTurn(session: Session, turnId: string, prompt: string): Promise<Session> {
    void turnId;
    void prompt;
    return session;
  }

  async function hostedSystemPrompt(
    basePrompt: string,
    personalizationSoul: string,
    session: Session,
    options: { mentionedApps?: OpenPondApp[]; openPondActionCatalog?: OpenPondActionCatalogEntry[] } = {}
  ): Promise<string> {
    const workspaceContext =
      session.workspaceKind === "local_project"
          ? (await looksLikeSandboxTemplateRepo(session.cwd))
            ? buildLocalSandboxTemplateTurnContext(session.cwd)
            : buildLocalProjectTurnContext(session.cwd)
        : session.workspaceKind === "sandbox" || session.workspaceKind === "sandbox_template"
          ? buildSandboxTurnContext(session.workspaceId, session.workspaceName)
          : buildGeneralWorkspaceTurnContext(session.cwd);
    const actionCatalogContext = buildActionCatalogContext(options.openPondActionCatalog ?? []);
    return buildPersonalizedSystemPrompt(
      personalizationSoul,
      [basePrompt, HOSTED_WORKSPACE_TOOL_PROTOCOL, workspaceContext, actionCatalogContext]
        .filter(Boolean)
        .join("\n\n")
    );
  }

  async function appendAssistantText(session: Session, turnId: string, text: string): Promise<void> {
    if (!text) return;
    await appendRuntimeEvent(
      event({
        sessionId: session.id,
        turnId,
        name: "assistant.delta",
        source: "provider",
        appId: session.appId,
        output: text,
      })
    );
  }

  async function appendHostedContextUsage(input: {
    session: Session;
    turnId: string;
    provider: "openpond";
    model: string;
    messages: HostedChatMessage[];
    usage?: unknown;
    includeCompletion?: boolean;
  }): Promise<void> {
    const usageEvent = event({
      sessionId: input.session.id,
      turnId: input.turnId,
      name: "session.context.updated",
      source: "server",
      appId: input.session.appId,
    });
    usageEvent.data = createContextUsageSnapshot({
      provider: input.provider,
      model: input.model,
      messages: input.messages,
      usage: input.usage,
      includeCompletion: input.includeCompletion,
      updatedAtEventId: usageEvent.id,
    });
    await appendRuntimeEvent(usageEvent);
  }

  return {
    maybeCreateScaffoldForTurn,
    hostedSystemPrompt,
    appendAssistantText,
    appendHostedContextUsage,
  };
}

function buildActionCatalogContext(actions: OpenPondActionCatalogEntry[]): string | null {
  if (actions.length === 0) return null;
  return [
    "OpenPond project action catalog:",
    "- These are the allowed source-defined actions for the selected OpenPond Project.",
    "- Use sandbox_run_action only when an action is needed, and pass the exact actionName from this catalog.",
    "- Do not infer hidden action names from user text.",
    ...actions.slice(0, 30).map((action) => {
      const label = action.label ?? action.name ?? action.id;
      const description = action.description ? ` - ${action.description}` : "";
      const inputSchema = schemaContext("input", action.inputSchema);
      const outputSchema = schemaContext("output", action.outputSchema);
      return [`- ${action.id}: ${label}${description}`, inputSchema, outputSchema]
        .filter(Boolean)
        .join("\n  ");
    }),
  ].join("\n");
}

function schemaContext(label: string, schema: OpenPondActionCatalogEntry["inputSchema"]): string | null {
  if (!schema) return null;
  const serialized = typeof schema === "string" ? schema : JSON.stringify(schema);
  return serialized ? `${label}Schema: ${serialized.slice(0, 1200)}` : null;
}

function buildLocalProjectTurnContext(workspacePath?: string | null): string {
  return [
    "Local project workspace context:",
    workspacePath ? `workspace: ${workspacePath}` : null,
    "- The active workspace is a user-selected local project folder.",
    "- Use list_files, read_files, search_files, write_file, write_files, edit_file, delete_file, and workspace_status for project work.",
    "- Use git_init when the user asks to turn a plain local project folder into a Git repository.",
    "- Use git_status, git_fetch, git_commit, and git_push only when the project is a Git repository.",
    "- Keep all file paths relative to the project workspace root.",
  ]
    .filter(Boolean)
    .join("\n");
}

function buildLocalSandboxTemplateTurnContext(workspacePath?: string | null): string {
  return [
    "Local sandbox template workspace context:",
    workspacePath ? `workspace: ${workspacePath}` : null,
    "- The active workspace is a user-selected local sandbox-template project with openpond.yaml.",
    "- Use list_files, read_files, search_files, write_file, write_files, edit_file, delete_file, and workspace_status for project work.",
    "- Use validate_sandbox_template to validate openpond.yaml.",
    "- Use publish_openpond_repo when the user asks to publish or connect the template source to OpenPond Git.",
    "- Use sandbox_create and sandbox_exec only when the user asks to start or test a hosted sandbox from the template.",
    "- Keep all file paths relative to the project workspace root.",
  ]
    .filter(Boolean)
    .join("\n");
}

function buildSandboxTurnContext(sandboxId?: string | null, sandboxName?: string | null): string {
  return [
    "Sandbox workspace context:",
    sandboxId ? `sandboxId: ${sandboxId}` : null,
    sandboxName ? `workspace: ${sandboxName}` : null,
    "- The active workspace is a remote Firecracker sandbox managed by OpenPond, not a local Git checkout.",
    "- Use sandbox_status, sandbox_list_files, sandbox_read_file, sandbox_search_files, sandbox_write_file, sandbox_edit_file, sandbox_delete_file, sandbox_mkdir, sandbox_move_file, sandbox_exec, sandbox_open_port, sandbox_logs, sandbox_receipts, and sandbox_stop.",
    "- Use sandbox_git_status, sandbox_git_diff, sandbox_git_export_patch, sandbox_git_branch, sandbox_git_commit, sandbox_git_pull, sandbox_git_push, sandbox_preserve_source, and sandbox_promote_source for git and preservation work inside the sandbox.",
    "- Use sandbox_templates to find published templates, sandbox_template_launch to switch into a sandbox launched from one, and sandbox_create only when the user asks for a new empty or repo-backed managed sandbox.",
    "- Use sandbox_snapshot_create, sandbox_snapshot_validate, sandbox_snapshot_publish, and sandbox_replay_start when the user asks for durable reusable runs or artifacts.",
    "- Keep paths relative to the sandbox workspace root unless the user explicitly provides an absolute path.",
    "- Use sandbox_exec for bounded commands and inspect output before making follow-up changes.",
    "- Durable outputs should be summarized as sandbox files, logs, receipts, preview URLs, artifact ids, replay ids, snapshot ids, or external database/resource refs rather than relying on a live sandbox staying up.",
  ]
    .filter(Boolean)
    .join("\n");
}

function buildGeneralWorkspaceTurnContext(workspacePath?: string | null): string {
  return [
    "General workspace context:",
    workspacePath ? `workspace: ${workspacePath}` : null,
    "- Use sandbox actions for remote sandboxes and file/git actions for selected local projects.",
    "- Ask the user to select a project or sandbox when a request needs a workspace and none is active.",
  ]
    .filter(Boolean)
    .join("\n");
}

async function looksLikeSandboxTemplateRepo(repoPath?: string | null): Promise<boolean> {
  if (!repoPath) return false;
  try {
    await fs.access(path.join(repoPath, OPENPOND_MANIFEST_FILE_NAME));
    return true;
  } catch {
    return false;
  }
}
