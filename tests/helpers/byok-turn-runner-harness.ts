import { createContextUsageSnapshot } from "../../apps/server/src/openpond/context-usage";
import { createBackgroundWorkerQueue } from "../../apps/server/src/runtime/background-worker-queue";
import { createTurnRunner } from "../../apps/server/src/runtime/turn-runner";
import {
  AppPreferencesSchema,
  ProviderSettingsSchema,
  type Approval,
  type AppPreferences,
  type ModelUsageRecord,
  type ProviderSettings,
  type RuntimeEvent,
  type Session,
  type Turn,
} from "../../packages/contracts/src";
import { withTurnRunnerTestStore } from "./turn-runner-test-harness";

export function createByokTurnRunnerHarness(input: {
  providerId?: "local-adapter" | "openpond" | "openrouter" | "zai";
  modelId?: string;
  toolArgs?: Record<string, unknown> | null;
  reasoningTextOnToolCall?: string;
  continuationOnToolCall?: import("../../packages/cloud/src/hosted-chat").HostedChatContinuation;
  initialEvents?: RuntimeEvent[];
  sessionOverrides?: Partial<Session>;
  finalText?: string;
  usage?: unknown;
  usageByPass?: Record<number, unknown>;
  failOnPass?: number;
  failure?: Error;
  preferences?: AppPreferences;
  providerSettings?: ProviderSettings;
  finalizeCrossSystemTurn?: NonNullable<Parameters<typeof createTurnRunner>[0]["finalizeCrossSystemTurn"]>;
}) {
  const providerId = input.providerId ?? "openrouter";
  const modelId = input.modelId ?? (providerId === "openpond" ? "openpond-chat" : "test/model");
  const sessions = new Map<string, Session>([
    [
      "session_1",
      baseSession({
        title: "BYOK turn runner",
        provider: providerId,
        modelRef: { providerId, modelId },
        ...input.sessionOverrides,
      }),
    ],
  ]);
  const turns: Turn[] = [];
  const events: RuntimeEvent[] = [...(input.initialEvents ?? [])];
  const approvals: Approval[] = [];
  const streamInputs: any[] = [];
  const usageRecords: ModelUsageRecord[] = [];
  const turnFollowUpQueue = createBackgroundWorkerQueue({ queueId: "turn-follow-up-byok" });
  let streamPass = 0;
  const runner = createTurnRunner({
    attachmentRootDir: "/tmp/openpond-test-attachments",
    store: withTurnRunnerTestStore({
      async snapshot() {
        return { events, turns };
      },
      async getTurn(turnId) {
        return turns.find((turn) => turn.id === turnId) ?? null;
      },
      async insertTurn(turn) {
        turns.push(turn);
      },
      async updateTurn(turnId, updater) {
        const index = turns.findIndex((turn) => turn.id === turnId);
        if (index === -1) return null;
        turns[index] = updater(turns[index]!);
        return turns[index]!;
      },
      async getApproval(approvalId) {
        return approvals.find((approval) => approval.id === approvalId) ?? null;
      },
      async upsertModelUsageRecord(record) {
        const index = usageRecords.findIndex((candidate) => candidate.requestId === record.requestId);
        if (index === -1) usageRecords.push(record);
        else usageRecords[index] = record;
        return record;
      },
    }),
    upsertApproval: async (approval) => {
      const index = approvals.findIndex((candidate) => candidate.id === approval.id);
      if (index === -1) approvals.push(approval);
      else approvals[index] = approval;
    },
    getSession: async (sessionId) => {
      const session = sessions.get(sessionId);
      if (!session) throw new Error(`unknown session ${sessionId}`);
      return session;
    },
    updateSession: async (sessionId, patch) => {
      const current = sessions.get(sessionId);
      if (!current) throw new Error(`unknown session ${sessionId}`);
      const next = { ...current, ...patch };
      sessions.set(sessionId, next);
      return next;
    },
    completeTurn: async (sessionId, turnId, providerTurnId = null) => {
      const turn = turns.find((candidate) => candidate.id === turnId);
      if (!turn) throw new Error("turn not found");
      Object.assign(turn, {
        providerTurnId,
        completedAt: "2026-07-03T10:00:01.000Z",
        status: "completed",
      });
      const current = sessions.get(sessionId);
      if (current) sessions.set(sessionId, { ...current, status: "idle" });
      return turn;
    },
    failTurn: async (_session, turnId, message) => {
      const turn = turns.find((candidate) => candidate.id === turnId);
      if (!turn) throw new Error("turn not found");
      Object.assign(turn, { status: "failed", error: message });
      return turn;
    },
    interruptTurn: async (_session, turnId) => {
      const turn = turns.find((candidate) => candidate.id === turnId);
      if (!turn) throw new Error("turn not found");
      Object.assign(turn, { status: "interrupted" });
      return turn;
    },
    defaultSessionCwd: () => "/tmp/openpond",
    findOpenPondApp: async () => {
      throw new Error("no app lookup expected");
    },
    resolveSessionWorkspaceCwd: async () => null,
    ensureCodexRuntime: async () => {
      throw new Error("Codex runtime should not be used for BYOK providers");
    },
    appendWorkspaceDiffEvent: async () => undefined,
    workspaceDiffBaseline: async () => null,
    appendRuntimeEvent: async (event) => {
      events.push(event);
    },
    executeWorkspaceTool: async () => {
      throw new Error("workspace tool execution should not be needed");
    },
    finalizeCrossSystemTurn: input.finalizeCrossSystemTurn,
    loadPersonalizationSoul: async () => "",
    loadAppPreferences: async () => input.preferences ?? AppPreferencesSchema.parse({}),
    loadProviderSettings: input.providerSettings ? async () => input.providerSettings! : undefined,
    maybeCreateScaffoldForTurn: async (nextSession) => nextSession,
    hostedSystemPrompt: async () => "System prompt",
    appendAssistantText: async (nextSession, turnId, text) => {
      events.push({
        id: `assistant_${events.length}`,
        sessionId: nextSession.id,
        turnId,
        name: "assistant.delta",
        timestamp: "2026-07-03T10:00:00.000Z",
        source: "provider",
        output: text,
      });
    },
    appendHostedContextUsage: async (contextInput) => {
      const usageEvent: RuntimeEvent = {
        id: `context_${events.length}`,
        sessionId: contextInput.session.id,
        turnId: contextInput.turnId,
        name: "session.context.updated",
        timestamp: "2026-07-03T10:00:00.000Z",
        source: "server",
        data: createContextUsageSnapshot({
          provider: contextInput.provider,
          model: contextInput.model,
          messages: contextInput.messages,
          maxContextTokens: contextInput.maxContextTokens,
          usage: contextInput.usage,
          includeCompletion: contextInput.includeCompletion,
          updatedAtEventId: null,
        }),
      };
      events.push(usageEvent);
    },
    streamOpenPondHostedChatTurn: async function* (streamInput) {
      streamInputs.push({
        providerId: "openpond",
        modelId: streamInput.model,
        messages: streamInput.messages,
        tools: streamInput.tools,
        toolChoice: streamInput.toolChoice,
      });
      for await (const delta of harnessStreamDeltas()) {
        if (delta.text) yield { type: "text_delta", text: delta.text, raw: delta.raw };
        if (delta.reasoningText) yield { type: "reasoning_delta", text: delta.reasoningText, raw: delta.raw };
        if (delta.toolCalls) yield { type: "tool_call_delta", toolCalls: delta.toolCalls, raw: delta.raw };
        if (delta.usage) yield { type: "usage", usage: delta.usage, raw: delta.raw };
        if (delta.finishReason !== undefined) yield { type: "finish", finishReason: delta.finishReason, raw: delta.raw };
      }
    },
    streamLocalByokChatTurn: async function* (streamInput) {
      if (providerId === "openpond") throw new Error("BYOK stream should not be used for OpenPond hosted tests");
      streamInputs.push(streamInput);
      yield* harnessStreamDeltas();
    },
    turnFollowUpQueue,
    maxHostedWorkspaceToolRounds: 3,
    maxRepeatedInvalidToolRequests: 2,
  });

  async function* harnessStreamDeltas() {
    streamPass += 1;
    const pass = streamPass;
    if (input.failOnPass === pass) throw input.failure ?? new Error(`stream failed on pass ${pass}`);
    if (pass === 1 && input.toolArgs) {
      if (input.reasoningTextOnToolCall) {
        yield { reasoningText: input.reasoningTextOnToolCall, raw: { pass, reasoning: true } };
      }
      if (input.continuationOnToolCall) {
        yield { continuation: input.continuationOnToolCall, raw: { pass, continuation: true } };
      }
      yield {
        toolCalls: [
          {
            index: 0,
            id: "call_test_tool",
            type: "function",
            function: {
              name: "missing_test_tool",
              arguments: JSON.stringify(input.toolArgs),
            },
          },
        ],
        raw: { pass },
      };
      const usage = usageForPass(pass);
      if (usage) yield { usage, raw: { pass, usage: true } };
      yield { finishReason: "tool_calls", raw: { pass } };
      return;
    }
    yield { text: input.finalText ?? "Turn handled.", raw: { pass } };
    const usage = usageForPass(pass);
    if (usage) yield { usage, raw: { pass, usage: true } };
  }

  function usageForPass(pass: number): unknown {
    if (input.usageByPass && Object.prototype.hasOwnProperty.call(input.usageByPass, pass)) {
      return input.usageByPass[pass];
    }
    const fallbackPass = input.toolArgs ? 2 : 1;
    return pass === fallbackPass ? input.usage : undefined;
  }

  return {
    runner,
    sessions,
    turns,
    events,
    approvals,
    streamInputs,
    usageRecords,
    turnFollowUpQueue,
  };
}

export function openRouterProviderSettingsWithContextWindow(contextWindow: number): ProviderSettings {
  return ProviderSettingsSchema.parse({
    providers: {
      openrouter: {
        enabled: true,
        baseUrl: "https://openrouter.ai/api/v1",
        defaultModel: "test/model",
      },
    },
    modelCaches: {
      openrouter: {
        providerId: "openrouter",
        source: "provider",
        fetchedAt: "2026-07-03T10:00:00.000Z",
        lastError: null,
        models: [
          {
            id: "test/model",
            providerId: "openrouter",
            displayName: "Test Model",
            contextWindow,
            outputLimit: null,
            source: "provider",
          },
        ],
      },
    },
  });
}

export function hostedCompactionPriorEvents(paddingCharacters = 0): RuntimeEvent[] {
  return [
    {
      id: "prior_turn_1_started",
      sessionId: "session_1",
      turnId: "prior_turn_1",
      name: "turn.started",
      timestamp: "2026-07-03T09:00:00.000Z",
      source: "server",
      args: { prompt: "We need to preserve the durable support workflow requirements." },
    },
    {
      id: "prior_turn_1_assistant",
      sessionId: "session_1",
      turnId: "prior_turn_1",
      name: "assistant.delta",
      timestamp: "2026-07-03T09:00:01.000Z",
      source: "provider",
      output:
        "Support workflow requirements were captured with local-only constraints." +
        "x".repeat(paddingCharacters),
    },
    {
      id: "prior_turn_2_started",
      sessionId: "session_1",
      turnId: "prior_turn_2",
      name: "turn.started",
      timestamp: "2026-07-03T09:05:00.000Z",
      source: "server",
      args: { prompt: "Keep the recent implementation notes available." },
    },
    {
      id: "prior_turn_2_assistant",
      sessionId: "session_1",
      turnId: "prior_turn_2",
      name: "assistant.delta",
      timestamp: "2026-07-03T09:05:01.000Z",
      source: "provider",
      output: "Recent notes remain available after compaction.",
    },
    {
      id: "prior_turn_3_started",
      sessionId: "session_1",
      turnId: "prior_turn_3",
      name: "turn.started",
      timestamp: "2026-07-03T09:10:00.000Z",
      source: "server",
      args: { prompt: "Continue from the current state." },
    },
    {
      id: "prior_turn_3_assistant",
      sessionId: "session_1",
      turnId: "prior_turn_3",
      name: "assistant.delta",
      timestamp: "2026-07-03T09:10:01.000Z",
      source: "provider",
      output: "Ready to continue from the current state.",
    },
  ];
}

export function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((nextResolve) => {
    resolve = nextResolve;
  });
  return { promise, resolve };
}

export function baseSession(overrides: Partial<Session> = {}): Session {
  return {
    id: "session_1",
    provider: "openrouter",
    modelRef: { providerId: "openrouter", modelId: "test/model" },
    title: "BYOK chat",
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
    createdAt: "2026-06-30T10:00:00.000Z",
    updatedAt: "2026-06-30T10:00:00.000Z",
    status: "idle",
    pinned: false,
    archived: false,
    order: 0,
    ...overrides,
  };
}
