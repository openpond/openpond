import type { HostedChatTool } from "@openpond/cloud";
import type {
  ChatProvider,
  OpenPondActionCatalogEntry,
  OpenPondApp,
  OpenPondProfileSkill,
  RuntimeEvent,
  Session,
  WorkspaceDiffSummary,
  WorkspaceToolResult,
} from "@openpond/contracts";
import { formatWorkspaceToolResultForModel } from "./hosted-tool-protocol.js";
import type { NativeModelToolResult } from "./native-tool-calls.js";
import {
  readSessionResource,
  searchSessionResources,
  type ResourceReadResult,
  type ResourceSearchResult,
} from "./resources.js";
import type { WebSearchExecutor, WebSearchResult, WebSearchResultItem } from "./web-search.js";

export type ToolVisibilityContext = {
  session: Session;
  provider: ChatProvider;
  model: string;
  mentionedApps: OpenPondApp[];
};

export type ModelToolExecutionContext = {
  session: Session;
  turnId: string;
  provider: ChatProvider;
  model: string;
  callId: string;
  args: Record<string, unknown>;
  signal: AbortSignal;
  workspaceDiffBaseline: WorkspaceDiffSummary | null;
  mentionedApps: OpenPondApp[];
  userPrompt: string;
};

export type ModelToolDefinition = {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
  enabled?: (context: ToolVisibilityContext) => boolean;
  execute: (context: ModelToolExecutionContext) => Promise<NativeModelToolResult>;
};

export type ProfileSkillReadResult = {
  name: string;
  description: string;
  body: string;
  path: string;
  sourceHash: string;
  charCount: number;
};

export function enabledModelToolDefinitions(
  definitions: ModelToolDefinition[],
  context: ToolVisibilityContext,
): ModelToolDefinition[] {
  return definitions.filter((definition) => definition.enabled?.(context) ?? true);
}

export function modelToolDefinitionToHostedTool(definition: ModelToolDefinition): HostedChatTool {
  return {
    type: "function",
    function: {
      name: definition.name,
      description: definition.description,
      parameters: definition.parameters,
    },
  };
}

export function createResourceModelToolDefinitions(deps: {
  runtimeEvents?: RuntimeEvent[];
  executeWorkspaceTool: (
    sessionId: string,
    payload: unknown,
    options?: { turnId?: string; workspaceDiffBaseline?: WorkspaceDiffSummary | null },
  ) => Promise<WorkspaceToolResult>;
}): ModelToolDefinition[] {
  const resourceEnabled = (context: ToolVisibilityContext) =>
    context.session.workspaceKind === "local_project" ||
    context.session.workspaceKind === "sandbox" ||
    context.session.workspaceKind === "sandbox_template" ||
    Boolean(deps.runtimeEvents?.length);

  return [
    {
      name: "resource_search",
      description:
        "Search the active workspace for resources by path or text and return stable resource refs with snippets.",
      parameters: {
        type: "object",
        additionalProperties: false,
        properties: {
          scope: {
            type: "string",
            enum: ["workspace", "events", "messages", "artifacts", "goal-context", "sandbox", "git"],
            description: "Resource scope to search. Use workspace for files, sandbox for active sandbox files, git for git status/diff refs, events for runtime events, messages for chat messages, artifacts for artifact refs and check outputs, and goal-context for current goal runtime context events.",
          },
          query: {
            type: "string",
            minLength: 1,
            description: "Path or text query to search for.",
          },
          limit: {
            type: "integer",
            minimum: 1,
            maximum: 100,
            description: "Maximum number of resource refs to return.",
          },
          filters: {
            type: "object",
            additionalProperties: true,
            description: "Optional scope-specific filters.",
          },
        },
        required: ["scope", "query"],
      },
      enabled: resourceEnabled,
      execute: async (context) => {
        const scope = context.args.scope;
        if (
          (scope === "events" || scope === "messages" || scope === "artifacts" || scope === "goal-context") &&
          deps.runtimeEvents
        ) {
          const result = searchSessionResources({
            events: deps.runtimeEvents,
            sessionId: context.session.id,
            request: {
              scope,
              query: stringArg(context.args, "query"),
              ...(typeof context.args.limit === "number" ? { limit: context.args.limit } : {}),
              ...(asRecord(context.args.filters) ? { filters: asRecord(context.args.filters)! } : {}),
            },
          });
          return resourceSearchResultToModelToolResult(context.callId, result);
        }
        if (scope === "sandbox") {
          const result = await deps.executeWorkspaceTool(
            context.session.id,
            {
              action: "sandbox_search_files",
              args: {
                query: stringArg(context.args, "query"),
                ...(typeof context.args.limit === "number" ? { maxResults: context.args.limit } : {}),
                ...(typeof asRecord(context.args.filters)?.path === "string"
                  ? { path: asRecord(context.args.filters)?.path }
                  : {}),
              },
              source: "chat_action",
            },
            {
              turnId: context.turnId,
              workspaceDiffBaseline: context.workspaceDiffBaseline,
            },
          );
          if (!result.ok) throw new Error(result.output || "Sandbox resource search failed.");
          return resourceSearchResultToModelToolResult(
            context.callId,
            sandboxWorkspaceToolSearchResult(result, stringArg(context.args, "query")),
          );
        }
        if (scope === "git") {
          return resourceSearchResultToModelToolResult(
            context.callId,
            gitResourceSearchResult(stringArg(context.args, "query")),
          );
        }
        const result = await deps.executeWorkspaceTool(
          context.session.id,
          {
            action: "resource_search",
            args: context.args,
            source: "chat_action",
          },
          {
            turnId: context.turnId,
            workspaceDiffBaseline: context.workspaceDiffBaseline,
          },
        );
        return workspaceToolResultToModelToolResult(context.callId, "resource_search", result);
      },
    },
    {
      name: "resource_read",
      description:
        "Read a resource by ref and return content, metadata, related refs, and truncation information.",
      parameters: {
        type: "object",
        additionalProperties: false,
        properties: {
          ref: {
            type: "string",
            minLength: 1,
            description: "Resource ref such as workspace:file:package.json, workspace:dir:src, sandbox:file:/workspace/app/src/index.ts, sandbox:dir:/workspace/app/src, git:status:working-tree, git:diff:working-tree, git:diff:staged, event:<id>, message:<id>, artifact:<eventId>:<encodedRef>, goal-context:<eventId>, or event:check-result:<eventId>:<index>.",
          },
          maxBytes: {
            type: "integer",
            minimum: 1,
            maximum: 240000,
            description: "Maximum UTF-8 bytes of content to return.",
          },
          mode: {
            type: "string",
            enum: ["content", "summary", "metadata"],
            description: "Read mode. Use metadata for binary or large resources when content is not needed.",
          },
        },
        required: ["ref"],
      },
      enabled: resourceEnabled,
      execute: async (context) => {
        const ref = stringArg(context.args, "ref");
        if (
          (ref.startsWith("event:") ||
            ref.startsWith("message:") ||
            ref.startsWith("artifact:") ||
            ref.startsWith("goal-context:")) &&
          deps.runtimeEvents
        ) {
          const resource = readSessionResource({
            events: deps.runtimeEvents,
            sessionId: context.session.id,
            request: {
              ref,
              ...(typeof context.args.maxBytes === "number" ? { maxBytes: context.args.maxBytes } : {}),
              ...(context.args.mode === "content" || context.args.mode === "summary" || context.args.mode === "metadata"
                ? { mode: context.args.mode }
                : {}),
            },
          });
          return resourceReadResultToModelToolResult(context.callId, resource);
        }
        if (ref.startsWith("sandbox:file:") || ref.startsWith("sandbox:dir:")) {
          const resource = await readSandboxResourceViaWorkspaceTool({
            ref,
            executeWorkspaceTool: deps.executeWorkspaceTool,
            session: context.session,
            turnId: context.turnId,
            workspaceDiffBaseline: context.workspaceDiffBaseline,
          });
          return resourceReadResultToModelToolResult(context.callId, resource);
        }
        if (ref.startsWith("git:")) {
          const resource = await readGitResourceViaWorkspaceTool({
            ref,
            executeWorkspaceTool: deps.executeWorkspaceTool,
            session: context.session,
            turnId: context.turnId,
            workspaceDiffBaseline: context.workspaceDiffBaseline,
          });
          return resourceReadResultToModelToolResult(context.callId, resource);
        }
        const result = await deps.executeWorkspaceTool(
          context.session.id,
          {
            action: "resource_read",
            args: context.args,
            source: "chat_action",
          },
          {
            turnId: context.turnId,
            workspaceDiffBaseline: context.workspaceDiffBaseline,
          },
        );
        return workspaceToolResultToModelToolResult(context.callId, "resource_read", result);
      },
    },
  ];
}

export function createWebSearchModelToolDefinition(deps: {
  executeWebSearch: WebSearchExecutor;
}): ModelToolDefinition {
  return {
    name: "web_search",
    description:
      "Search the web for current or external information. Cite by source title or source name in prose; the app renders clickable source pills, so do not paste raw URLs unless the user explicitly asks for URLs.",
    parameters: {
      type: "object",
      additionalProperties: false,
      properties: {
        query: {
          type: "string",
          minLength: 1,
          description: "Search query.",
        },
        limit: {
          type: "integer",
          minimum: 1,
          maximum: 10,
          description: "Maximum number of results to return.",
        },
        recencyDays: {
          type: "integer",
          minimum: 0,
          description: "Only return results from this many recent days when supported.",
        },
        domains: {
          type: "array",
          maxItems: 10,
          items: { type: "string" },
          description: "Optional domain filters.",
        },
      },
      required: ["query"],
    },
    execute: async (context) => {
      const result = await deps.executeWebSearch(
        {
          query: stringArg(context.args, "query"),
          ...(typeof context.args.limit === "number" ? { limit: context.args.limit } : {}),
          ...(typeof context.args.recencyDays === "number" ? { recencyDays: context.args.recencyDays } : {}),
          ...(Array.isArray(context.args.domains)
            ? { domains: context.args.domains.filter((item): item is string => typeof item === "string") }
            : {}),
        },
        { signal: context.signal },
      );
      return {
        toolCallId: context.callId,
        name: "web_search",
        ok: true,
        contentText: JSON.stringify(
          {
            ok: true,
            action: "web_search",
            output: `Found ${result.results.length} web result${result.results.length === 1 ? "" : "s"}. Use the source titles or names for citations; do not paste raw URLs unless the user asks.`,
            data: { result: webSearchResultForModel(result) },
          },
          null,
          2,
        ),
        data: { result },
      };
    },
  };
}

function webSearchResultForModel(result: WebSearchResult): Omit<WebSearchResult, "results"> & {
  results: Array<Omit<WebSearchResultItem, "url" | "faviconUrl"> & { citation: string; domain: string | null }>;
} {
  return {
    query: result.query,
    provider: result.provider,
    searchedAt: result.searchedAt,
    truncated: result.truncated,
    results: result.results.map((item, index) => ({
      id: item.id,
      citation: `[${index + 1}]`,
      title: item.title,
      snippet: item.snippet,
      sourceName: item.sourceName,
      domain: hostnameFromUrl(item.url),
      publishedAt: item.publishedAt,
      updatedAt: item.updatedAt,
    })),
  };
}

function hostnameFromUrl(value: string): string | null {
  try {
    return new URL(value).hostname.replace(/^www\./i, "");
  } catch {
    return null;
  }
}

export function createOpenPondProfileSkillModelToolDefinitions(deps: {
  skills: OpenPondProfileSkill[];
  readProfileSkill: (name: string) => Promise<ProfileSkillReadResult>;
}): ModelToolDefinition[] {
  const enabledSkills = deps.skills
    .filter((skill) => skill.enabled && skill.validationStatus === "valid")
    .sort((left, right) => left.name.localeCompare(right.name));
  if (enabledSkills.length === 0) return [];
  const skillByName = new Map(enabledSkills.map((skill) => [skill.name, skill]));
  return [
    {
      name: "profile_skill_read",
      description:
        "Read the full body of one enabled OpenPond profile skill by name before following that skill's workflow.",
      parameters: {
        type: "object",
        additionalProperties: false,
        properties: {
          name: {
            type: "string",
            minLength: 1,
            ...(enabledSkills.length <= 100 ? { enum: enabledSkills.map((skill) => skill.name) } : {}),
            description: "Profile skill name from the Available profile skills list.",
          },
        },
        required: ["name"],
      },
      execute: async (context) => {
        const name = stringArg(context.args, "name");
        const skill = skillByName.get(name);
        if (!skill) {
          return failedActionToolResult(
            context.callId,
            "profile_skill_read",
            `Profile skill ${name} is not in the active enabled skill catalog.`,
          );
        }
        const loaded = await deps.readProfileSkill(name);
        return {
          toolCallId: context.callId,
          name: "profile_skill_read",
          ok: true,
          contentText: JSON.stringify(
            {
              ok: true,
              action: "profile_skill_read",
              output: `Loaded profile skill ${loaded.name}.`,
              data: { skill: loaded },
            },
            null,
            2,
          ),
          data: { skill: loaded },
        };
      },
    },
  ];
}

export function createOpenPondActionModelToolDefinitions(deps: {
  actionCatalog: OpenPondActionCatalogEntry[];
  executeWorkspaceTool: (
    sessionId: string,
    payload: unknown,
    options?: { turnId?: string; workspaceDiffBaseline?: WorkspaceDiffSummary | null },
  ) => Promise<WorkspaceToolResult>;
  executeProfileAction?: (payload: unknown) => Promise<unknown>;
}): ModelToolDefinition[] {
  if (deps.actionCatalog.length === 0) return [];
  const actionById = new Map(deps.actionCatalog.map((action) => [action.id, action]));
  const enabled = () => actionById.size > 0;
  return [
    {
      name: "openpond_action_search",
      description:
        "Search the selected or mentioned OpenPond action catalog. Returns scoped action ids that may be runnable.",
      parameters: {
        type: "object",
        additionalProperties: false,
        properties: {
          query: { type: "string", minLength: 1 },
          limit: { type: "integer", minimum: 1, maximum: 20 },
        },
        required: ["query"],
      },
      enabled,
      execute: async (context) => {
        const query = stringArg(context.args, "query").toLowerCase();
        const limit = typeof context.args.limit === "number"
          ? Math.min(Math.max(Math.floor(context.args.limit), 1), 20)
          : 10;
        const matches = deps.actionCatalog
          .filter((action) => actionCatalogText(action).includes(query))
          .slice(0, limit)
          .map(actionCatalogItemForModel);
        return {
          toolCallId: context.callId,
          name: "openpond_action_search",
          ok: true,
          contentText: JSON.stringify(
            {
              ok: true,
              action: "openpond_action_search",
              output: `Found ${matches.length} action${matches.length === 1 ? "" : "s"}.`,
              data: { actions: matches },
            },
            null,
            2,
          ),
          data: { actions: matches },
        };
      },
    },
    {
      name: "openpond_action_run",
      description:
        "Run one allowed OpenPond action from the scoped action catalog by stable actionId.",
      parameters: {
        type: "object",
        additionalProperties: false,
        properties: {
          actionId: { type: "string", minLength: 1 },
          input: { type: "object", additionalProperties: true },
          projectId: { type: "string", minLength: 1 },
          agentId: { type: "string", minLength: 1 },
        },
        required: ["actionId"],
      },
      enabled,
      execute: async (context) => {
        const actionId = stringArg(context.args, "actionId");
        const action = actionById.get(actionId);
        if (!action) {
          return failedActionToolResult(
            context.callId,
            "openpond_action_run",
            `Action ${actionId} is not in the scoped allowed action catalog.`,
          );
        }
        const implementation = asRecord(action.implementation);
        if (implementation?.type === "openpond-profile-action") {
          if (!deps.executeProfileAction) {
            return failedActionToolResult(
              context.callId,
              "openpond_action_run",
              `Action ${actionId} is a profile action, but profile action execution is not configured.`,
            );
          }
          const profileActionId = stringValue(implementation.actionId) ?? action.id;
          const input = asRecord(context.args.input) ?? {};
          const prompt = stringValue(input.prompt) ?? stringValue(input.message) ?? context.userPrompt;
          const result = await deps.executeProfileAction({
            action: profileActionId,
            input: {
              ...input,
              prompt,
              message: prompt,
              source: "openpond_app",
            },
            metadata: {
              source: "openpond_app",
              selectedActionId: profileActionId,
              selectedActionLabel: action.label ?? action.name ?? profileActionId,
              selectedBy: "native_model_tool",
              displayPrompt: context.userPrompt,
              sessionId: context.session.id,
            },
          });
          return {
            toolCallId: context.callId,
            name: "openpond_action_run",
            ok: true,
            contentText: JSON.stringify(
              {
                ok: true,
                action: "openpond_action_run",
                output: `Ran profile action ${profileActionId}.`,
                data: { result },
              },
              null,
              2,
            ),
            data: { result },
          };
        }
        const actionName = action.sourceActionId ?? action.name ?? action.id;
        const payloadArgs: Record<string, unknown> = {
          actionName,
          input: asRecord(context.args.input) ?? {},
        };
        const allowedProjectId = stringValue(implementation?.projectId);
        const requestedProjectId = stringValue(context.args.projectId);
        if (requestedProjectId) {
          if (!allowedProjectId || requestedProjectId !== allowedProjectId) {
            return failedActionToolResult(
              context.callId,
              "openpond_action_run",
              `Project ${requestedProjectId} is not authorized for action ${actionId}.`,
            );
          }
          payloadArgs.projectId = requestedProjectId;
        } else if (allowedProjectId) {
          payloadArgs.projectId = allowedProjectId;
        }
        const allowedAgentId = action.agentId ?? stringValue(implementation?.agentId);
        const requestedAgentId = stringValue(context.args.agentId);
        if (requestedAgentId) {
          if (!allowedAgentId || requestedAgentId !== allowedAgentId) {
            return failedActionToolResult(
              context.callId,
              "openpond_action_run",
              `Agent ${requestedAgentId} is not authorized for action ${actionId}.`,
            );
          }
          payloadArgs.agentId = requestedAgentId;
        } else if (allowedAgentId) {
          payloadArgs.agentId = allowedAgentId;
        }
        const result = await deps.executeWorkspaceTool(
          context.session.id,
          {
            action: "sandbox_run_action",
            args: payloadArgs,
            source: "chat_action",
          },
          {
            turnId: context.turnId,
            workspaceDiffBaseline: context.workspaceDiffBaseline,
          },
        );
        return workspaceToolResultToModelToolResult(context.callId, "openpond_action_run", result);
      },
    },
  ];
}

function workspaceToolResultToModelToolResult(
  callId: string,
  name: string,
  result: WorkspaceToolResult,
): NativeModelToolResult {
  return {
    toolCallId: callId,
    name,
    ok: result.ok,
    contentText: formatWorkspaceToolResultForModel(result),
    data: result.data,
  };
}

function sandboxWorkspaceToolSearchResult(
  result: WorkspaceToolResult,
  query: string,
): ResourceSearchResult {
  const items: ResourceSearchResult["items"] = [];
  const seen = new Set<string>();
  for (const item of sandboxPathItems(result.data)) {
    const ref = `sandbox:file:${item.path}`;
    if (seen.has(ref)) continue;
    seen.add(ref);
    items.push({
      ref,
      title: item.path,
      snippet: item.snippet ?? "Sandbox file match",
      score: 0.8,
      metadata: {
        source: "sandbox",
        path: item.path,
        line: item.line ?? null,
      },
    });
  }
  return {
    query,
    scope: "sandbox",
    items,
    truncated: false,
  };
}

async function readSandboxResourceViaWorkspaceTool(input: {
  ref: string;
  executeWorkspaceTool: (
    sessionId: string,
    payload: unknown,
    options?: { turnId?: string; workspaceDiffBaseline?: WorkspaceDiffSummary | null },
  ) => Promise<WorkspaceToolResult>;
  session: Session;
  turnId: string;
  workspaceDiffBaseline: WorkspaceDiffSummary | null;
}): Promise<ResourceReadResult> {
  const isDir = input.ref.startsWith("sandbox:dir:");
  const sandboxPath = input.ref.slice(isDir ? "sandbox:dir:".length : "sandbox:file:".length);
  const result = await input.executeWorkspaceTool(
    input.session.id,
    {
      action: isDir ? "sandbox_list_files" : "sandbox_read_file",
      args: { path: sandboxPath || "." },
      source: "chat_action",
    },
    {
      turnId: input.turnId,
      workspaceDiffBaseline: input.workspaceDiffBaseline,
    },
  );
  if (!result.ok) throw new Error(result.output || `Sandbox resource read failed: ${sandboxPath || "."}`);
  if (isDir) {
    const entries = sandboxPathItems(result.data);
    const content = entries.map((entry) => `${entry.kind ?? "file"} ${entry.path}`).join("\n");
    return {
      ref: `sandbox:dir:${sandboxPath || "."}`,
      kind: "sandbox.dir",
      title: sandboxPath || ".",
      contentType: "inode/directory",
      contentText: content,
      metadata: {
        path: sandboxPath || ".",
        entryCount: entries.length,
        entries,
        ok: result.ok,
      },
      relatedRefs: entries.slice(0, 50).map((entry) =>
        entry.kind === "directory" ? `sandbox:dir:${entry.path}` : `sandbox:file:${entry.path}`,
      ),
      truncation: {
        truncated: false,
        originalBytes: Buffer.byteLength(content, "utf8"),
        returnedBytes: Buffer.byteLength(content, "utf8"),
      },
    };
  }

  const fileMetadata = sandboxFileMetadata(result.data, sandboxPath);
  if (fileMetadata.binary) {
    return {
      ref: `sandbox:file:${sandboxPath}`,
      kind: "sandbox.file",
      title: sandboxPath,
      contentType: fileMetadata.contentType,
      metadata: {
        path: sandboxPath,
        ok: result.ok,
        binary: true,
        sizeBytes: fileMetadata.sizeBytes,
      },
      relatedRefs: [`sandbox:dir:${parentResourcePath(sandboxPath)}`],
      truncation: {
        truncated: false,
        originalBytes: fileMetadata.sizeBytes ?? 0,
        returnedBytes: 0,
        reason: "binary",
      },
    };
  }

  const content = sandboxFileContent(result.data) ?? result.output;
  const contentBytes = Buffer.byteLength(content, "utf8");
  return {
    ref: `sandbox:file:${sandboxPath}`,
    kind: "sandbox.file",
    title: sandboxPath,
    contentType: fileMetadata.contentType,
    contentText: content,
    metadata: {
      path: sandboxPath,
      ok: result.ok,
      binary: false,
      sizeBytes: fileMetadata.sizeBytes,
    },
    relatedRefs: [`sandbox:dir:${parentResourcePath(sandboxPath)}`],
    truncation: {
      truncated: false,
      originalBytes: contentBytes,
      returnedBytes: contentBytes,
    },
  };
}

function gitResourceSearchResult(query: string): ResourceSearchResult {
  const normalized = query.toLowerCase();
  const candidates = [
    {
      ref: "git:status:working-tree",
      title: "Git status",
      snippet: "Current branch, upstream, ahead/behind state, and changed files.",
      score: 0.9,
      metadata: { source: "git", kind: "status" },
      haystack: "git status working tree changed files branch upstream dirty",
    },
    {
      ref: "git:diff:working-tree",
      title: "Git working tree diff",
      snippet: "Unstaged working tree diff.",
      score: 0.85,
      metadata: { source: "git", kind: "diff", staged: false },
      haystack: "git diff working tree unstaged patch changes",
    },
    {
      ref: "git:diff:staged",
      title: "Git staged diff",
      snippet: "Staged git diff.",
      score: 0.84,
      metadata: { source: "git", kind: "diff", staged: true },
      haystack: "git diff staged cached patch index changes",
    },
  ];
  const items = candidates
    .filter((item) => item.haystack.includes(normalized) || item.ref.includes(normalized))
    .map(({ haystack: _haystack, ...item }) => item);
  return {
    query,
    scope: "git",
    items,
    truncated: false,
  };
}

async function readGitResourceViaWorkspaceTool(input: {
  ref: string;
  executeWorkspaceTool: (
    sessionId: string,
    payload: unknown,
    options?: { turnId?: string; workspaceDiffBaseline?: WorkspaceDiffSummary | null },
  ) => Promise<WorkspaceToolResult>;
  session: Session;
  turnId: string;
  workspaceDiffBaseline: WorkspaceDiffSummary | null;
}): Promise<ResourceReadResult> {
  const sandboxMode = input.session.workspaceKind === "sandbox" || input.session.workspaceKind === "sandbox_template";
  const action = gitResourceWorkspaceAction(input.ref, sandboxMode);
  const result = await input.executeWorkspaceTool(
    input.session.id,
    {
      action: action.name,
      args: action.args,
      source: "chat_action",
    },
    {
      turnId: input.turnId,
      workspaceDiffBaseline: input.workspaceDiffBaseline,
    },
  );
  if (input.ref === "git:status:working-tree") {
    const content = JSON.stringify(result.data ?? { output: result.output }, null, 2);
    return {
      ref: input.ref,
      kind: "git.status",
      title: "Git status",
      contentType: "application/json",
      contentText: content,
      metadata: {
        action: action.name,
        ok: result.ok,
        changedFileRefs: gitChangedFileRefs(result.data),
      },
      relatedRefs: gitChangedFileRefs(result.data),
      truncation: {
        truncated: false,
        originalBytes: Buffer.byteLength(content, "utf8"),
        returnedBytes: Buffer.byteLength(content, "utf8"),
      },
    };
  }
  const diff = gitDiffText(result.data) ?? result.output;
  return {
    ref: input.ref,
    kind: "git.diff",
    title: input.ref === "git:diff:staged" ? "Git staged diff" : "Git working tree diff",
    contentType: "text/x-diff",
    contentText: diff,
    metadata: {
      action: action.name,
      ok: result.ok,
      staged: input.ref === "git:diff:staged",
    },
    relatedRefs: [],
    truncation: {
      truncated: false,
      originalBytes: Buffer.byteLength(diff, "utf8"),
      returnedBytes: Buffer.byteLength(diff, "utf8"),
    },
  };
}

function gitResourceWorkspaceAction(ref: string, sandboxMode: boolean): { name: string; args: Record<string, unknown> } {
  if (ref === "git:status:working-tree") {
    return { name: sandboxMode ? "sandbox_git_status" : "git_status", args: {} };
  }
  if (ref === "git:diff:working-tree") {
    return { name: sandboxMode ? "sandbox_git_diff" : "git_diff", args: {} };
  }
  if (ref === "git:diff:staged") {
    return { name: sandboxMode ? "sandbox_git_diff" : "git_diff", args: { staged: true } };
  }
  throw new Error(`Unsupported git resource ref: ${ref}`);
}

function gitChangedFileRefs(value: unknown): string[] {
  const record = asRecord(value);
  const status = asRecord(record?.status);
  const files: unknown[] = Array.isArray(record?.files)
    ? record.files
    : Array.isArray(status?.files)
      ? status.files
      : [];
  return files
    .filter((item): item is Record<string, unknown> => Boolean(item) && typeof item === "object" && !Array.isArray(item))
    .map((item) => stringValue(item.path))
    .filter((item): item is string => Boolean(item))
    .map((filePath) => `workspace:file:${filePath}`);
}

function gitDiffText(value: unknown): string | null {
  const record = asRecord(value);
  return stringValue(record?.diff) ?? stringValue(asRecord(record?.result)?.diff);
}

function sandboxPathItems(value: unknown): Array<{ path: string; snippet?: string; line?: number | null; kind?: string | null }> {
  const records = nestedArraysForKeys(value, ["matches", "files", "entries"]);
  const items: Array<{ path: string; snippet?: string; line?: number | null; kind?: string | null }> = [];
  for (const record of records) {
    const path = stringValue(record.path) ?? stringValue(record.name);
    if (!path) continue;
    items.push({
      path,
      snippet: stringValue(record.text) ?? stringValue(record.snippet) ?? stringValue(record.content) ?? undefined,
      line: typeof record.line === "number" ? record.line : null,
      kind: stringValue(record.kind) ?? stringValue(record.type),
    });
  }
  return items;
}

function nestedArraysForKeys(value: unknown, keys: string[]): Record<string, unknown>[] {
  if (!value || typeof value !== "object") return [];
  const record = value as Record<string, unknown>;
  const output: Record<string, unknown>[] = [];
  for (const key of keys) {
    const child = record[key];
    if (Array.isArray(child)) {
      output.push(...child.filter((item): item is Record<string, unknown> => Boolean(item) && typeof item === "object" && !Array.isArray(item)));
    }
  }
  for (const child of Object.values(record)) {
    if (child && typeof child === "object" && !Array.isArray(child)) {
      output.push(...nestedArraysForKeys(child, keys));
    }
  }
  return output;
}

function sandboxFileContent(value: unknown): string | null {
  const record = asRecord(value);
  const file = sandboxFileRecord(value);
  const encoded = stringValue(file?.contentsBase64) ?? stringValue(record?.contentsBase64);
  if (encoded && !sandboxFileMetadata(value, stringValue(file?.path) ?? "").binary) {
    try {
      return Buffer.from(encoded, "base64").toString("utf8");
    } catch {
      return null;
    }
  }
  return (
    stringValue(record?.content) ??
    stringValue(record?.text) ??
    stringValue(record?.contents) ??
    stringValue(file?.content) ??
    stringValue(file?.text)
  );
}

function contentTypeForResourcePath(value: string): string | null {
  const lower = value.toLowerCase();
  if (lower.endsWith(".json")) return "application/json";
  if (lower.endsWith(".md") || lower.endsWith(".mdx")) return "text/markdown";
  if (/\.(css|csv|html|js|jsx|ts|tsx|txt|yaml|yml)$/.test(lower)) return "text/plain";
  return null;
}

function sandboxFileRecord(value: unknown): Record<string, unknown> | null {
  const record = asRecord(value);
  return asRecord(record?.file) ?? asRecord(asRecord(record?.result)?.file);
}

function sandboxFileMetadata(
  value: unknown,
  resourcePath: string,
): { binary: boolean; contentType: string | null; sizeBytes?: number } {
  const file = sandboxFileRecord(value);
  const contentType = stringValue(file?.contentType) ?? stringValue(file?.mimeType) ?? contentTypeForResourcePath(resourcePath);
  const sizeBytes = numberValue(file?.sizeBytes) ?? numberValue(file?.size);
  const binary =
    file?.binary === true ||
    file?.isBinary === true ||
    (contentType ? isBinaryContentType(contentType) : isLikelyBinaryResourcePath(resourcePath));
  return { binary, contentType, ...(sizeBytes !== null ? { sizeBytes } : {}) };
}

function isBinaryContentType(value: string): boolean {
  return (
    value.startsWith("image/") ||
    value.startsWith("video/") ||
    value.startsWith("audio/") ||
    value === "application/pdf" ||
    value === "application/octet-stream" ||
    value.includes("zip") ||
    value.includes("sqlite")
  );
}

function isLikelyBinaryResourcePath(value: string): boolean {
  return /\.(7z|avif|db|gif|gz|ico|jpe?g|mov|mp4|pdf|png|sqlite|tar|webp|xlsm?|xlsx|zip)$/i.test(value);
}

function parentResourcePath(value: string): string {
  const normalized = value.replace(/\/+$/, "");
  const index = normalized.lastIndexOf("/");
  if (index <= 0) return ".";
  return normalized.slice(0, index);
}

function resourceSearchResultToModelToolResult(
  callId: string,
  result: ResourceSearchResult,
): NativeModelToolResult {
  return {
    toolCallId: callId,
    name: "resource_search",
    ok: true,
    contentText: JSON.stringify(
      {
        ok: true,
        action: "resource_search",
        output: `Found ${result.items.length} resource${result.items.length === 1 ? "" : "s"}.`,
        data: { result },
      },
      null,
      2,
    ),
    data: { result },
  };
}

function resourceReadResultToModelToolResult(
  callId: string,
  resource: ResourceReadResult,
): NativeModelToolResult {
  return {
    toolCallId: callId,
    name: "resource_read",
    ok: true,
    contentText: JSON.stringify(
      {
        ok: true,
        action: "resource_read",
        output: `Read resource ${resource.ref}.`,
        data: { resource },
      },
      null,
      2,
    ),
    data: { resource },
  };
}

function stringArg(args: Record<string, unknown>, key: string): string {
  const value = args[key];
  if (typeof value !== "string" || !value.trim()) throw new Error(`${key} is required`);
  return value.trim();
}

function actionCatalogText(action: OpenPondActionCatalogEntry): string {
  return [
    action.id,
    action.name,
    action.label,
    action.description,
    action.sourceActionId,
    action.agentId,
  ]
    .filter((value): value is string => typeof value === "string" && value.trim().length > 0)
    .join(" ")
    .toLowerCase();
}

function actionCatalogItemForModel(action: OpenPondActionCatalogEntry): Record<string, unknown> {
  const implementation = asRecord(action.implementation);
  const directRunAllowed = implementation?.type !== "openpond-profile-action";
  return {
    actionId: action.id,
    name: action.name ?? action.id,
    label: action.label ?? action.name ?? action.id,
    description: action.description ?? null,
    directRunAllowed,
    inputSchema: action.inputSchema ?? null,
    outputSchema: action.outputSchema ?? null,
    agentId: action.agentId ?? stringValue(implementation?.agentId),
    projectId: stringValue(implementation?.projectId),
    sourceActionId: action.sourceActionId ?? null,
  };
}

function failedActionToolResult(
  callId: string,
  name: string,
  message: string,
): NativeModelToolResult {
  return {
    toolCallId: callId,
    name,
    ok: false,
    contentText: JSON.stringify(
      {
        ok: false,
        action: name,
        output: message,
      },
      null,
      2,
    ),
  };
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function stringValue(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function numberValue(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}
