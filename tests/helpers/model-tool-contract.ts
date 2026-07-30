import type { Session } from "../../packages/contracts/src";
import type {
  ModelToolDefinition,
  ModelToolExecutionContext,
} from "../../apps/server/src/openpond/model-tool-registry";

export function modelToolSession(overrides: Partial<Session> = {}): Session {
  return {
    id: "session_1",
    provider: "openrouter",
    modelRef: { providerId: "openrouter", modelId: "test/model" },
    openPondCommandAccessMode: "ask",
    title: "Model tool contract",
    appId: null,
    appName: null,
    workspaceKind: undefined,
    workspaceId: null,
    workspaceName: null,
    localProjectId: null,
    cloudProjectId: null,
    cloudTeamId: null,
    cwd: null,
    codexThreadId: null,
    createdAt: "2026-07-30T10:00:00.000Z",
    updatedAt: "2026-07-30T10:00:00.000Z",
    status: "idle",
    pinned: false,
    archived: false,
    order: 0,
    ...overrides,
  };
}

export function modelToolContext(
  args: Record<string, unknown>,
  overrides: Partial<ModelToolExecutionContext> = {},
): ModelToolExecutionContext {
  return {
    session: modelToolSession(),
    turnId: "turn_1",
    provider: "openrouter",
    model: "test/model",
    callId: "call_1",
    args,
    signal: new AbortController().signal,
    workspaceDiffBaseline: null,
    mentionedApps: [],
    userPrompt: "Exercise the model tool.",
    ...overrides,
  };
}

export function requireModelTool(
  definitions: ModelToolDefinition[],
  name: string,
): ModelToolDefinition {
  const definition = definitions.find((candidate) => candidate.name === name);
  if (!definition) throw new Error(`Missing model tool definition: ${name}`);
  return definition;
}
