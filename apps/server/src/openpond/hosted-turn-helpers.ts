import { promises as fs } from "node:fs";
import path from "node:path";
import { isManagedLocalWorkSession } from "../work/managed-local-work.js";
import {
  DEFAULT_SESSION_EXPERIENCE,
  OPENPOND_MANIFEST_FILE_NAME,
  type ChatProvider,
  type OpenPondApp,
  type OpenPondActionCatalogEntry,
  type OpenPondProfileSkill,
  type RuntimeEvent,
  type Session,
} from "@openpond/contracts";
import type { HostedChatMessage } from "@openpond/cloud";
import { materializeAgentPrompt } from "@openpond/agent-runtime";
import { createContextUsageSnapshot } from "./context-usage.js";
import {
  hostedToolProtocolForInstructionMode,
  type HostedToolInstructionMode,
} from "./hosted-tool-protocol.js";
import {
  buildConnectedAppIndexContext,
  type ResolvedConnectedAppContext,
} from "./connected-app-context.js";
import { buildPersonalizedSystemPrompt } from "./personalization.js";
import { REPOSITORY_WORK_SYSTEM_CONTEXT } from "./repository-work-system-context.js";
import {
  buildRepositoryInstructionContext,
  resolveRepositoryInstructions,
} from "./repository-instructions.js";
import { event } from "../utils.js";
import { experienceUsesWorkspaceToolProtocol } from "../runtime/experience-policy.js";

export type ActionCatalogInstructionMode =
  | "text_fallback"
  | "native_tool"
  | "none";
export type ProfileSkillInstructionMode =
  | "text_fallback"
  | "native_tool"
  | "none";

export type HostedProfileSkillBody = {
  name: string;
  description: string;
  body: string;
  path: string;
  sourceHash: string;
  packagePath?: string;
  resourceFiles?: string[];
};

export type HostedTurnHelpers = {
  maybeCreateScaffoldForTurn(
    session: Session,
    turnId: string,
    prompt: string
  ): Promise<Session>;
  hostedSystemPrompt(
    basePrompt: string,
    personalizationSoul: string,
    session: Session,
    options?: {
      mentionedApps?: OpenPondApp[];
      openPondActionCatalog?: OpenPondActionCatalogEntry[];
      openPondProfileSkills?: OpenPondProfileSkill[];
      loadedProfileSkills?: HostedProfileSkillBody[];
      connectedApps?: ResolvedConnectedAppContext[];
      toolInstructionMode?: HostedToolInstructionMode;
      actionCatalogInstructionMode?: ActionCatalogInstructionMode;
      profileSkillInstructionMode?: ProfileSkillInstructionMode;
      browserControlAvailable?: boolean;
      extraSystemContext?: string | null;
    }
  ): Promise<string>;
  appendAssistantText(
    session: Session,
    turnId: string,
    text: string
  ): Promise<void>;
  appendHostedContextUsage(input: {
    session: Session;
    turnId: string;
    provider: ChatProvider;
    model: string;
    messages: HostedChatMessage[];
    maxContextTokens?: number | null;
    usage?: unknown;
    includeCompletion?: boolean;
  }): Promise<void>;
};

export function createHostedTurnHelpers(deps: {
  appendRuntimeEvent: (runtimeEvent: RuntimeEvent) => Promise<void>;
  onRepositoryInstructionDiagnostic?: (
    diagnostic: string,
    session: Session,
  ) => void;
}): HostedTurnHelpers {
  const { appendRuntimeEvent } = deps;

  async function maybeCreateScaffoldForTurn(
    session: Session,
    turnId: string,
    prompt: string
  ): Promise<Session> {
    void turnId;
    void prompt;
    return session;
  }

  async function hostedSystemPrompt(
    basePrompt: string,
    personalizationSoul: string,
    session: Session,
    options: {
      mentionedApps?: OpenPondApp[];
      openPondActionCatalog?: OpenPondActionCatalogEntry[];
      openPondProfileSkills?: OpenPondProfileSkill[];
      loadedProfileSkills?: HostedProfileSkillBody[];
      connectedApps?: ResolvedConnectedAppContext[];
      toolInstructionMode?: HostedToolInstructionMode;
      actionCatalogInstructionMode?: ActionCatalogInstructionMode;
      profileSkillInstructionMode?: ProfileSkillInstructionMode;
      browserControlAvailable?: boolean;
      extraSystemContext?: string | null;
    } = {}
  ): Promise<string> {
    const experience = session.experience ?? DEFAULT_SESSION_EXPERIENCE;
    const requestedToolInstructionMode =
      options.toolInstructionMode ?? "full_text_fallback";
    const policySession = { ...session, experience };
    const toolInstructionMode = experienceUsesWorkspaceToolProtocol(policySession)
      ? requestedToolInstructionMode
      : "none";
    const isHybridSession = isHybridWorkspaceSession(session);
    const repositoryWork = experienceUsesWorkspaceToolProtocol(policySession);
    const developmentContext = repositoryWork ? REPOSITORY_WORK_SYSTEM_CONTEXT : "";
    let repositoryInstructionContext = "";
    if (
      repositoryWork &&
      session.workspaceKind === "local_project"
    ) {
      const resolution = await resolveRepositoryInstructions(session.cwd);
      for (const diagnostic of resolution?.diagnostics ?? []) {
        deps.onRepositoryInstructionDiagnostic?.(diagnostic, session);
      }
      repositoryInstructionContext =
        buildRepositoryInstructionContext(resolution);
    }
    const workspaceContext =
      experience === "chat"
        ? buildChatExperienceContext()
        : experience === "work" && !repositoryWork
        ? buildWorkExperienceContext(session)
        : isManagedLocalWorkSession(session)
        ? buildManagedLocalWorkTurnContext(session.cwd)
        : session.workspaceKind === "local_project"
        ? (await looksLikeSandboxTemplateRepo(session.cwd))
          ? buildLocalSandboxTemplateTurnContext(
              session.cwd,
              toolInstructionMode
            )
          : buildLocalProjectTurnContext(session.cwd, toolInstructionMode)
        : session.workspaceKind === "sandbox" ||
          session.workspaceKind === "sandbox_template"
        ? isHybridSession
          ? buildHybridSandboxTurnContext(
              session.workspaceId,
              session.workspaceName,
              toolInstructionMode
            )
          : buildSandboxTurnContext(
              session.workspaceId,
              session.workspaceName,
              toolInstructionMode
            )
        : buildGeneralWorkspaceTurnContext(session.cwd, toolInstructionMode);
    const toolProtocol =
      hostedToolProtocolForInstructionMode(toolInstructionMode);
    const actionCatalogContext = buildActionCatalogContext(
      options.openPondActionCatalog ?? [],
      options.actionCatalogInstructionMode ?? "text_fallback"
    );
    const profileSkillContext = buildProfileSkillContext({
      skills: options.openPondProfileSkills ?? [],
      loadedSkills: options.loadedProfileSkills ?? [],
      mode: options.profileSkillInstructionMode ?? "none",
    });
    const capabilityIndexContext = buildOpenPondCapabilityIndexContext({
      browserControlAvailable: options.browserControlAvailable === true,
      experience,
      hybridWorkspace: isHybridSession,
    });
    const connectedAppContext = buildConnectedAppIndexContext(
      options.connectedApps ?? []
    );
    return materializeAgentPrompt({
      system: buildPersonalizedSystemPrompt(personalizationSoul, ""),
      harnessInstructions: [],
      skillInstructions: [],
      hostInstructions: [
        basePrompt,
        developmentContext,
        toolProtocol,
        workspaceContext,
        repositoryInstructionContext,
        capabilityIndexContext,
        connectedAppContext,
        actionCatalogContext,
        profileSkillContext,
        options.extraSystemContext,
      ].filter((part): part is string => Boolean(part)),
    });
  }

  async function appendAssistantText(
    session: Session,
    turnId: string,
    text: string
  ): Promise<void> {
    if (!text) return;
    const assistantEvent = event({
        sessionId: session.id,
        turnId,
        name: "assistant.delta",
        source: "provider",
        appId: session.appId,
        output: text,
      });
    await appendRuntimeEvent(assistantEvent);
  }

  async function appendHostedContextUsage(input: {
    session: Session;
    turnId: string;
    provider: ChatProvider;
    model: string;
    messages: HostedChatMessage[];
    maxContextTokens?: number | null;
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
      maxContextTokens: input.maxContextTokens,
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

const PROFILE_SKILL_INDEX_BUDGET_CHARS = 6000;
const PROFILE_SKILL_DESCRIPTION_MAX_CHARS = 280;
const PROFILE_SKILL_BODY_MAX_CHARS = 80000;

function buildOpenPondCapabilityIndexContext(
  input: {
    browserControlAvailable?: boolean;
    experience?: Session["experience"];
    hybridWorkspace?: boolean;
  } = {}
): string {
  return [
    "OpenPond capabilities:",
    "- workspace_context: use resource_search and resource_read for workspace, session, artifact, goal, sandbox, and git context.",
    "- authoring_skills: /skill preloads openpond-skill-authoring and /agent preloads openpond-agent-authoring. Profile Skills, including $openpond-refiner-authoring, load through their $skill-name tag in a normal model turn. For matching natural-language authoring requests, load the relevant bundled profile skill from the catalog.",
    ...(input.hybridWorkspace
      ? [
          "- In Hybrid workspace mode, use the ordinary scoped workspace capabilities exposed for that turn; authoring skills do not grant new filesystem authority.",
        ]
      : []),
    ...(input.browserControlAvailable
      ? input.experience === "work"
        ? [
            "- browser_control: Work may open, snapshot, move over, and scroll the desktop in-app browser for read-only inspection. Browser clicks, typing, key presses, account changes, and publication are not available through this boundary.",
          ]
        : [
            "- browser_control: use openpond_browser_* native tools to open, snapshot, move the cursor, click, type, press keys, and scroll in the desktop in-app browser when visible browser interaction is needed.",
          ]
      : []),
    "- web_fetch: fetch and read a known HTTP(S) URL when the user provides a link or exact page; use web_search for discovery by query.",
    "- web_search: search current or external information when web search is available and the answer depends on current facts.",
    "- schedule_work: create a durable one-time or recurring workflow attached to the current chat when the user asks to schedule work. Resolve the exact cadence, local date/time, and timezone, then call schedule_work; future runs and their output return to the attached chat. This is an app-native tool, not a profile skill.",
    "- action_run: search and run scoped project or profile actions from the allowed action catalog.",
    "- profile_skill: load existing profile skills for reusable instruction workflows, not app-native controls or permissions.",
    "- Capability names are not slash commands. Use available native tools or server-confirmed workflow state, and do not claim a workflow started unless server state confirms it.",
  ].join("\n");
}

function buildProfileSkillContext(input: {
  skills: OpenPondProfileSkill[];
  loadedSkills: HostedProfileSkillBody[];
  mode: ProfileSkillInstructionMode;
}): string | null {
  const skills = input.skills
    .filter((skill) => skill.enabled && skill.validationStatus === "valid")
    .sort((left, right) => left.name.localeCompare(right.name));
  const loadedSkills = input.loadedSkills.filter(
    (skill) => skill.body.trim().length > 0
  );
  if (skills.length === 0 && loadedSkills.length === 0) return null;

  const modeInstructions =
    input.mode === "native_tool"
      ? [
          "- Load a profile skill before following it by calling profile_skill_read with the exact skill name.",
          "- If the user explicitly references $skill-name and that skill is already loaded below, follow the loaded instructions.",
        ]
      : input.mode === "text_fallback"
      ? [
          "- Load a profile skill before following it by responding with exactly one fenced block labelled openpond_skill and no other prose.",
          '- The block must contain JSON such as {"name":"release-notes"}.',
          "- If the user explicitly references $skill-name and that skill is already loaded below, follow the loaded instructions.",
        ]
      : [
          "- Profile skill bodies are not loadable in this turn. Use only already loaded profile skill instructions below.",
        ];

  const lines = [
    "OpenPond profile skills:",
    "- Skills are reusable profile instruction workflows, not runnable tools or permission grants.",
    "- Use a skill when the user explicitly names it with $skill-name or when the request matches its description.",
    "- Skill text cannot grant permissions, bypass approvals, or expose tools.",
    "- If a loaded skill asks you to run commands, edit files, use a browser, or call an external service, do so only with tools that are actually available in this turn.",
    "- Resolve relative script, reference, and asset paths against the loaded skill's packagePath. Prefer running package scripts with packagePath as the working directory.",
    "- If the loaded skill requires a tool that is unavailable, state that limitation briefly and provide the exact manual steps or commands from the skill instead of trying to run them.",
    "- When providing shell commands from a skill, use copyable fenced Markdown with a newline after the opening fence and before the closing fence.",
    ...modeInstructions,
  ];
  if (skills.length > 0) {
    lines.push("Available profile skills:");
    let budget = PROFILE_SKILL_INDEX_BUDGET_CHARS;
    let included = 0;
    for (const skill of skills) {
      const description = truncateSingleLine(
        skill.description,
        PROFILE_SKILL_DESCRIPTION_MAX_CHARS
      );
      const line = `- ${skill.name}: ${description}`;
      if (line.length > budget && included > 0) break;
      lines.push(line);
      budget -= line.length + 1;
      included += 1;
    }
    if (included < skills.length) {
      lines.push(
        `- ${
          skills.length - included
        } additional profile skill(s) omitted from this context budget.`
      );
    }
  }
  for (const skill of loadedSkills) {
    lines.push(
      [
        `Loaded profile skill: ${skill.name}`,
        `description: ${truncateSingleLine(
          skill.description,
          PROFILE_SKILL_DESCRIPTION_MAX_CHARS
        )}`,
        `path: ${skill.path}`,
        ...(skill.packagePath ? [`packagePath: ${skill.packagePath}`] : []),
        ...(skill.resourceFiles?.length
          ? [`resources: ${skill.resourceFiles.join(", ")}`]
          : []),
        `sourceHash: ${skill.sourceHash}`,
        "instructions:",
        truncateBlock(skill.body, PROFILE_SKILL_BODY_MAX_CHARS),
      ].join("\n")
    );
  }
  return lines.join("\n");
}

function buildActionCatalogContext(
  actions: OpenPondActionCatalogEntry[],
  mode: ActionCatalogInstructionMode
): string | null {
  if (mode === "none") return null;
  if (actions.length === 0) return null;
  const usage =
    mode === "native_tool"
      ? [
          "- These are the allowed source-defined actions for the selected OpenPond Project.",
          "- Profile Agent actions may also be available as direct native function tools. When one directly matches the request, call it instead of searching the catalog.",
          "- Use openpond_action_search to find action ids when needed.",
          "- Use openpond_action_run only with an actionId from this catalog or from openpond_action_search.",
          "- Do not infer hidden action ids from user text.",
        ]
      : [
          "- These are the allowed source-defined actions for the selected OpenPond Project.",
          "- Use sandbox_run_action only when an action is needed, and pass the exact actionName from this catalog.",
          "- Do not infer hidden action names from user text.",
        ];
  return [
    "OpenPond project action catalog:",
    ...usage,
    ...actions.slice(0, 30).map((action) => {
      const label = action.label ?? action.name ?? action.id;
      const description = action.description ? ` - ${action.description}` : "";
      const inputSchema = schemaContext("input", action.inputSchema);
      const outputSchema = schemaContext("output", action.outputSchema);
      return [
        `- ${action.id}: ${label}${description}`,
        inputSchema,
        outputSchema,
      ]
        .filter(Boolean)
        .join("\n  ");
    }),
  ].join("\n");
}

function truncateSingleLine(value: string, maxChars: number): string {
  const singleLine = value.replace(/\s+/g, " ").trim();
  if (singleLine.length <= maxChars) return singleLine;
  return `${singleLine.slice(0, Math.max(0, maxChars - 3)).trimEnd()}...`;
}

function truncateBlock(value: string, maxChars: number): string {
  if (value.length <= maxChars) return value;
  return `${value
    .slice(0, Math.max(0, maxChars - 30))
    .trimEnd()}\n\n[profile skill truncated]`;
}

function schemaContext(
  label: string,
  schema: OpenPondActionCatalogEntry["inputSchema"]
): string | null {
  if (!schema) return null;
  const serialized =
    typeof schema === "string" ? schema : JSON.stringify(schema);
  return serialized ? `${label}Schema: ${serialized.slice(0, 1200)}` : null;
}

function buildChatExperienceContext(): string {
  return [
    "Chat experience:",
    "- Answer conversationally using the supplied prompt, attachments, and available web tools.",
    "- General workspace compute, plugins, local commands, repository tools, deployment tools, and sandbox tools are not available.",
    "- If the user asks for multi-step workspace work or a durable generated file, explain that they should start a Work task.",
  ].join("\n");
}

function buildWorkExperienceContext(session: Session): string {
  return [
    "Work experience:",
    "- Carry multi-step everyday work to a reviewable result using the Work, web, plugin/connector, and approval tools actually available in this turn.",
    "- Work compute is lazy. Do not start a sandbox when the request can be completed directly.",
    session.workspaceId
      ? `- Active managed workspace: ${session.workspaceId}.`
      : "- No managed workspace is active yet. A Work tool will create one when compute is actually needed.",
    "- The managed workspace layout is /workspace/inputs, /workspace/work, and /workspace/outputs; ordinary commands run from /workspace/work.",
    "- Use work_capabilities before promising an unfamiliar file type or destination; it does not start compute.",
    "- Treat supplied files and folders as authoritative references: inspect them before drafting, preserve requested structure and style, and create a new output revision instead of overwriting a saved result.",
    "- Place completed file candidates in /workspace/outputs and call work_save_output so the result survives sandbox cleanup.",
    "- When the requested result is a reusable OpenPond Agent, use work_prepare_agent for the SDK project and finish with work_save_agent_package; that tool runs the SDK validation and eval gate and returns an immutable reviewed package.",
    "- If Agent preparation, validation, evals, or package saving fails, report that blocker plainly. Do not substitute a generic file output or claim that an Agent package was completed.",
    "- When an approved connected write or deployment already created the durable result elsewhere, call work_register_external_output with its stable provider id or URL instead of copying it through the sandbox.",
    "- Connected writes, sharing, and publication require explicit user intent and provider readback. Otherwise create a reviewable local draft.",
    "- Repository, git, interactive terminal, source-promotion, and deployment capabilities require repository-aware Work and are not available in this projectless run.",
  ].join("\n");
}

function buildManagedLocalWorkTurnContext(
  workspacePath: string | null | undefined,
): string {
  return [
    "Local Work experience:",
    workspacePath ? `- Managed task workspace: ${workspacePath}.` : null,
    "- Work directly in this app-managed task directory. It is not a user-selected software repository.",
    "- Keep scratch files organized, and do not read or write outside this task directory unless the user explicitly asks.",
    "- In the final response, link every finished file the user should keep or download. Linked files are validated and copied into durable Outputs storage at turn completion.",
    "- Do not label a file as downloadable unless it exists in this task directory and is ready for review.",
  ]
    .filter(Boolean)
    .join("\n");
}

function buildLocalProjectTurnContext(
  workspacePath: string | null | undefined,
  toolInstructionMode: HostedToolInstructionMode
): string {
  if (toolInstructionMode !== "full_text_fallback") {
    return [
      "Local project workspace context:",
      workspacePath ? `workspace: ${workspacePath}` : null,
      "- The active workspace is a user-selected local project folder.",
      '- Use available native resource tools for workspace inspection, especially resource_search and resource_read. Prefer targeted path or identifier queries with limit 5-10, then read likely refs. Avoid repeated broad one-word searches unless the word is an exact component/function/file identifier. For workspace resource_search, omit filters.mode for exact literal path/text search, use filters.mode="path" for file/path lookup, and use filters.mode="ranked" for broad multi-term retrieval.',
      "- Keep resource refs and file paths relative to the project workspace root.",
      "- Do not claim local file changes, git changes, or command execution unless an available tool result confirms them.",
    ]
      .filter(Boolean)
      .join("\n");
  }
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

function buildLocalSandboxTemplateTurnContext(
  workspacePath: string | null | undefined,
  toolInstructionMode: HostedToolInstructionMode
): string {
  if (toolInstructionMode !== "full_text_fallback") {
    return [
      "Local sandbox template workspace context:",
      workspacePath ? `workspace: ${workspacePath}` : null,
      "- The active workspace is a user-selected local sandbox-template project with openpond.yaml.",
      '- Use available native resource tools for inspection, especially resource_search and resource_read. Prefer targeted path or identifier queries with limit 5-10, then read likely refs. Avoid repeated broad one-word searches unless the word is an exact component/function/file identifier. For workspace resource_search, omit filters.mode for exact literal path/text search, use filters.mode="path" for file/path lookup, and use filters.mode="ranked" for broad multi-term retrieval.',
      "- Keep resource refs and file paths relative to the project workspace root.",
      "- Do not claim validation, publishing, file changes, git changes, or sandbox execution unless an available tool result confirms them.",
    ]
      .filter(Boolean)
      .join("\n");
  }
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

function buildSandboxTurnContext(
  sandboxId: string | null | undefined,
  sandboxName: string | null | undefined,
  toolInstructionMode: HostedToolInstructionMode
): string {
  if (toolInstructionMode !== "full_text_fallback") {
    return [
      "Sandbox workspace context:",
      sandboxId ? `sandboxId: ${sandboxId}` : null,
      sandboxName ? `workspace: ${sandboxName}` : null,
      "- The active workspace is a remote sandbox managed by OpenPond.",
      "- Use available native resource tools for inspection, especially resource_search with scope sandbox and resource_read on sandbox refs.",
      "- Keep sandbox resource paths relative to the sandbox workspace root unless the user explicitly provides an absolute path.",
      "- Do not claim sandbox file changes, commands, git operations, logs, ports, or snapshots unless an available tool result confirms them.",
    ]
      .filter(Boolean)
      .join("\n");
  }
  return [
    "Sandbox workspace context:",
    sandboxId ? `sandboxId: ${sandboxId}` : null,
    sandboxName ? `workspace: ${sandboxName}` : null,
    "- The active workspace is a remote sandbox managed by OpenPond, not a local Git checkout.",
    "- Use sandbox_status, sandbox_list_files, sandbox_read_file, sandbox_search_files, sandbox_write_file, sandbox_edit_file, sandbox_delete_file, sandbox_mkdir, sandbox_move_file, sandbox_exec, sandbox_open_port, sandbox_logs, sandbox_receipts, and sandbox_stop.",
    "- Use sandbox_git_status, sandbox_git_diff, sandbox_git_export_patch, sandbox_git_apply_patch_local, sandbox_git_branch, sandbox_git_commit, sandbox_git_pull, sandbox_git_push, sandbox_preserve_source, and sandbox_promote_source for git and preservation work. sandbox_git_export_patch is read-only; sandbox_git_apply_patch_local mutates the linked local checkout and requires an explicit user request.",
    "- Use sandbox_templates to find published templates, sandbox_template_launch to switch into a sandbox launched from one, and sandbox_create only when the user asks for a new empty or repo-backed managed sandbox.",
    "- Use sandbox_snapshot_create, sandbox_snapshot_validate, sandbox_snapshot_publish, and sandbox_replay_start when the user asks for durable reusable runs or artifacts.",
    "- Keep paths relative to the sandbox workspace root unless the user explicitly provides an absolute path.",
    "- Use sandbox_exec for bounded commands and inspect output before making follow-up changes.",
    "- Durable outputs should be summarized as sandbox files, logs, receipts, preview URLs, artifact ids, replay ids, snapshot ids, or external database/resource refs rather than relying on a live sandbox staying up.",
  ]
    .filter(Boolean)
    .join("\n");
}

function buildHybridSandboxTurnContext(
  sandboxId: string | null | undefined,
  sandboxName: string | null | undefined,
  toolInstructionMode: HostedToolInstructionMode
): string {
  const context = buildSandboxTurnContext(
    sandboxId,
    sandboxName,
    toolInstructionMode
  );
  const hybridRules = [
    "Hybrid workspace context:",
    "- The selected Project is backed by a hosted sandbox. Treat normal requests to inspect, edit, test, or diff project files as sandbox workspace work.",
    "- For file edits like README, source, config, or docs updates, inspect and change the active sandbox using sandbox/resource/git tools; do not route those edits through goals or Create Pipeline.",
    "- Keep the user's local checkout unchanged unless the user explicitly asks to preserve, promote, apply, or export sandbox changes.",
    "- Agent and Skill authoring remain normal skill-backed turns; do not start Create Pipeline or Goal mode for them.",
  ];
  return [context, hybridRules.join("\n")].filter(Boolean).join("\n");
}

function buildGeneralWorkspaceTurnContext(
  workspacePath: string | null | undefined,
  toolInstructionMode: HostedToolInstructionMode
): string {
  if (toolInstructionMode !== "full_text_fallback") {
    return [
      "General workspace context:",
      workspacePath ? `workspace: ${workspacePath}` : null,
      "- Use available native resource tools for workspace inspection when a workspace is active.",
      "- Ask the user to select a project or sandbox when a request needs a workspace and none is active.",
    ]
      .filter(Boolean)
      .join("\n");
  }
  return [
    "General workspace context:",
    workspacePath ? `workspace: ${workspacePath}` : null,
    "- Use sandbox actions for remote sandboxes and file/git actions for selected local projects.",
    "- Ask the user to select a project or sandbox when a request needs a workspace and none is active.",
  ]
    .filter(Boolean)
    .join("\n");
}

function isHybridWorkspaceSession(session: Session): boolean {
  return session.metadata?.workspaceTarget === "hybrid";
}

async function looksLikeSandboxTemplateRepo(
  repoPath?: string | null
): Promise<boolean> {
  if (!repoPath) return false;
  try {
    await fs.access(path.join(repoPath, OPENPOND_MANIFEST_FILE_NAME));
    return true;
  } catch {
    return false;
  }
}
