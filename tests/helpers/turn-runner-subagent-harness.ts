import { spawnSync } from "node:child_process";
import { writeFile } from "node:fs/promises";
import path from "node:path";
import { createBackgroundWorkerQueue } from "../../apps/server/src/runtime/background-worker-queue";
import { createTurnRunner } from "../../apps/server/src/runtime/turn-runner";
import {
  AppPreferencesSchema,
  ModelUsageRecordSchema,
  SubagentMessageSchema,
  SubagentRunSchema,
  type Approval,
  type AppPreferences,
  type ConnectedAppConnectionLike,
  type ModelUsageRecord,
  type RuntimeEvent,
  type Session,
  type SubagentMessage,
  type SubagentRun,
  type Turn,
  type WorkspaceToolResult,
} from "../../packages/contracts/src";
import { withTurnRunnerTestStore } from "./turn-runner-test-harness";

export function createSubagentHarness(input: {
  toolName: string;
  toolArgs: Record<string, unknown>;
  preferences: AppPreferences;
  initialEvents?: RuntimeEvent[];
  initialTurns?: Turn[];
  initialRuns?: SubagentRun[];
  initialMessages?: SubagentMessage[];
  initialUsageRecords?: ModelUsageRecord[];
  sessionOverrides?: Partial<Session>;
  applyWorkspaceWrites?: boolean;
  writeOnChildReport?: {
    roleId: string;
    path: string;
    content: string;
  };
  usageBySessionId?: Record<string, unknown>;
  textBySessionId?: Record<string, string[]>;
  forceStoredChildTurnFailureAfterComplete?: string;
  stallManagedChildDispatchAfterPersistedComplete?: boolean;
  stallChildGetTurnAfterPersistedComplete?: boolean;
  stallLatestPersistedChildTurnAfterComplete?: boolean;
  returnManagedChildDispatchBeforePersistedCompleteMs?: number;
  interruptTurnErrorForSessionId?: string;
  onStreamInput?: (
    streamInput: any,
    context: {
      streamPass: number;
      requestTurn: Turn | undefined;
      requestSession: Session | null;
      events: RuntimeEvent[];
      runs: SubagentRun[];
      injectedFlags: Record<string, boolean>;
    },
  ) => void | Promise<void>;
  toolCallForStream?: (
    streamInput: any,
    context: {
      streamPass: number;
      requestTurn: Turn | undefined;
      requestSession: Session | null;
      events: RuntimeEvent[];
      runs: SubagentRun[];
      injectedFlags: Record<string, boolean>;
    },
  ) => { name: string; args: Record<string, unknown>; id?: string } | null | Promise<{ name: string; args: Record<string, unknown>; id?: string } | null>;
  workspaceToolResultForRequest?: (input: {
    sessionId: string;
    request: any;
  }) => WorkspaceToolResult | null | Promise<WorkspaceToolResult | null>;
  executeOpenPondCommand?: (input: {
    command: string;
    cwd?: string | null;
    timeoutSeconds?: number | null;
  }) => Promise<{
    ok: boolean;
    command: string;
    cwd: string | null;
    exitCode: number | null;
    stdout: string;
    stderr: string;
    timedOut: boolean;
    timeoutSeconds: number;
    truncated: boolean;
    blockedReason: string | null;
  }>;
  maxHostedWorkspaceToolRounds?: number;
  notifySubagentRunStateChanged?: (run: SubagentRun) => void;
  disableDefaultToolCall?: boolean;
  enableWebSearchTool?: boolean;
  integrationConnections?: ConnectedAppConnectionLike[];
  forkSandboxForSubagent?: (input: {
    sandboxId: string;
    payload: Record<string, unknown>;
    parentSession: Session;
    role: AppPreferences["subagents"]["roles"][number];
    runId: string;
  }) => Promise<unknown>;
  cleanupSandboxForSubagent?: (input: {
    sandboxId: string;
    run: SubagentRun;
  }) => Promise<unknown>;
}) {
  const sessions = new Map<string, Session>([
    ["session_1", baseSession(input.sessionOverrides)],
  ]);
  const turns: Turn[] = [...(input.initialTurns ?? [])];
  const events: RuntimeEvent[] = [...(input.initialEvents ?? [])];
  const approvals: Approval[] = [];
  const runs: SubagentRun[] = [...(input.initialRuns ?? [])];
  const messages: SubagentMessage[] = [...(input.initialMessages ?? [])];
  const usageRecords: ModelUsageRecord[] = [...(input.initialUsageRecords ?? [])];
  const workspaceRequests: Array<{ sessionId: string; request: any }> = [];
  const sandboxForkRequests: Array<{
    sandboxId: string;
    payload: Record<string, unknown>;
    parentSession: Session;
    role: AppPreferences["subagents"]["roles"][number];
    runId: string;
  }> = [];
  const sandboxCleanupRequests: Array<{
    sandboxId: string;
    run: SubagentRun;
  }> = [];
  const streamInputs: any[] = [];
  let streamPass = 0;
  const injectedFlags: Record<string, boolean> = {};
  const subagentQueue = createBackgroundWorkerQueue({ queueId: "subagent-test" });
  const turnFollowUpQueue = createBackgroundWorkerQueue({ queueId: "turn-follow-up-subagent-test" });

  const runner = createTurnRunner({
    attachmentRootDir: "/tmp/openpond-test-attachments",
    store: withTurnRunnerTestStore({
      async snapshot() {
        return { events, turns };
      },
      async getTurn(turnId) {
        const turn = turns.find((candidate) => candidate.id === turnId) ?? null;
        if (
          turn?.status === "completed" &&
          sessions.get(turn.sessionId)?.subagentRunId &&
          input.stallChildGetTurnAfterPersistedComplete
        ) {
          await new Promise<never>(() => undefined);
        }
        return turn;
      },
      async latestPersistedTurnForSession(sessionId, status) {
        const latest = turns
          .filter((turn) => turn.sessionId === sessionId && (!status || turn.status === status))
          .sort((left, right) => right.sortIndex - left.sortIndex)[0] ?? null;
        if (
          latest?.status === "completed" &&
          sessions.get(sessionId)?.subagentRunId &&
          input.stallLatestPersistedChildTurnAfterComplete
        ) {
          await new Promise<never>(() => undefined);
        }
        return latest;
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
        const parsed = ModelUsageRecordSchema.parse(record);
        const index = usageRecords.findIndex((candidate) => candidate.requestId === parsed.requestId);
        if (index === -1) usageRecords.push(parsed);
        else usageRecords[index] = parsed;
        return parsed;
      },
      async listModelUsageRecords(query = {}) {
        return usageRecords.filter((record) => {
          if (query.sessionId && record.sessionId !== query.sessionId) return false;
          if (query.turnId && record.turnId !== query.turnId) return false;
          if (query.visibility && query.visibility !== "all" && record.visibility !== query.visibility) return false;
          if (query.status && query.status !== "all") {
            if (query.status === "missing") {
              if (record.source !== "missing") return false;
            } else if (record.status !== query.status) {
              return false;
            }
          }
          return true;
        }).slice(0, query.limit ?? 1000);
      },
      async upsertSubagentRun(run) {
        const parsed = SubagentRunSchema.parse(run);
        const index = runs.findIndex((candidate) => candidate.id === parsed.id);
        if (index === -1) runs.push(parsed);
        else runs[index] = parsed;
        return parsed;
      },
      async getSubagentRun(runId) {
        return runs.find((run) => run.id === runId) ?? null;
      },
      async listSubagentRuns(query = {}) {
        return runs.filter((run) => {
          if (query.parentSessionId && run.parentSessionId !== query.parentSessionId) return false;
          if (query.parentGoalId && run.parentGoalId !== query.parentGoalId) return false;
          if (query.childSessionId && run.childSessionId !== query.childSessionId) return false;
          if (query.status) {
            const statuses = Array.isArray(query.status) ? query.status : [query.status];
            if (!statuses.includes(run.status)) return false;
          }
          return true;
        }).slice(0, query.limit ?? 1000);
      },
      async appendSubagentMessage(message) {
        messages.push(message);
        return message;
      },
      async listSubagentMessages(query = {}) {
        return messages.filter((message) => {
          if (query.parentGoalId && message.parentGoalId !== query.parentGoalId) return false;
          if (query.fromRunId && message.fromRunId !== query.fromRunId) return false;
          if (query.toRunId && message.toRunId !== query.toRunId) return false;
          if (query.toRole && message.toRole !== query.toRole) return false;
          return true;
        }).slice(0, query.limit ?? 1000);
      },
    }),
    upsertApproval: async (approval) => {
      const index = approvals.findIndex((candidate) => candidate.id === approval.id);
      if (index === -1) approvals.push(approval);
      else approvals[index] = approval;
    },
    createSession: async (payload) => {
      const record = payload as Partial<Session>;
      const session = baseSession({
        id: `session_${sessions.size + 1}`,
        provider: record.provider ?? "openrouter",
        modelRef: record.modelRef,
        openPondCommandAccessMode: record.openPondCommandAccessMode,
        hiddenFromDefaultSidebar: record.hiddenFromDefaultSidebar,
        parentSessionId: record.parentSessionId,
        parentTurnId: record.parentTurnId,
        parentGoalId: record.parentGoalId,
        subagentRunId: record.subagentRunId,
        subagentRoleId: record.subagentRoleId,
        title: record.title ?? "Child session",
        appId: record.appId ?? null,
        appName: record.appName ?? null,
        workspaceKind: record.workspaceKind,
        workspaceId: record.workspaceId ?? null,
        workspaceName: record.workspaceName ?? null,
        localProjectId: record.localProjectId ?? null,
        cloudProjectId: record.cloudProjectId ?? null,
        cloudTeamId: record.cloudTeamId ?? null,
        metadata: record.metadata,
        cwd: record.cwd ?? null,
      });
      sessions.set(session.id, session);
      return session;
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
      const session = sessions.get(sessionId);
      if (
        session?.subagentRunId &&
        input.returnManagedChildDispatchBeforePersistedCompleteMs !== undefined
      ) {
        const early = { ...turn };
        setTimeout(() => {
          Object.assign(turn, {
            providerTurnId,
            completedAt: "2026-07-07T10:00:01.000Z",
            status: "completed",
          });
          sessions.set(sessionId, { ...session, status: "idle" });
        }, input.returnManagedChildDispatchBeforePersistedCompleteMs);
        return early;
      }
      Object.assign(turn, {
        providerTurnId,
        completedAt: "2026-07-07T10:00:01.000Z",
        status: "completed",
      });
      if (session) sessions.set(sessionId, { ...session, status: "idle" });
      const completed = { ...turn };
      if (session?.subagentRunId && input.forceStoredChildTurnFailureAfterComplete) {
        Object.assign(turn, {
          completedAt: "2026-07-07T10:00:02.000Z",
          status: "failed",
          error: input.forceStoredChildTurnFailureAfterComplete,
        });
        sessions.set(sessionId, { ...session, status: "failed" });
      }
      if (session?.subagentRunId && input.stallManagedChildDispatchAfterPersistedComplete) {
        await new Promise<never>(() => undefined);
      }
      return completed;
    },
    failTurn: async (_session, turnId, message) => {
      const turn = turns.find((candidate) => candidate.id === turnId);
      if (!turn) throw new Error("turn not found");
      Object.assign(turn, { status: "failed", error: message });
      return turn;
    },
    interruptTurn: async (session, turnId) => {
      if (session.id === input.interruptTurnErrorForSessionId) throw new Error("Turn not found");
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
    forkSandboxForSubagent: input.forkSandboxForSubagent
      ? async (request) => {
          sandboxForkRequests.push(request);
          return input.forkSandboxForSubagent!(request);
        }
      : undefined,
    cleanupSandboxForSubagent: input.cleanupSandboxForSubagent
      ? async (request) => {
          sandboxCleanupRequests.push(request);
          return input.cleanupSandboxForSubagent!(request);
        }
      : undefined,
    executeWorkspaceTool: async (sessionId, request) => {
      workspaceRequests.push({ sessionId, request });
      const customResult = await input.workspaceToolResultForRequest?.({ sessionId, request });
      if (customResult) return customResult;
      if (input.applyWorkspaceWrites && request.action === "write_file") {
        const session = sessions.get(sessionId);
        const filePath = typeof request.args?.path === "string" ? request.args.path : null;
        const content = typeof request.args?.content === "string" ? request.args.content : "";
        if (!session?.cwd || !filePath) throw new Error("write_file test request is missing cwd or path");
        await writeFile(path.join(session.cwd, filePath), content, "utf8");
      }
      return {
        ok: true,
        action: request.action,
        output: "workspace tool executed",
      };
    },
    executeOpenPondCommand: input.executeOpenPondCommand
      ? async (request) => input.executeOpenPondCommand!({
          command: request.command,
          cwd: request.cwd ?? null,
          timeoutSeconds: request.timeoutSeconds ?? null,
        })
      : undefined,
    executeWebSearch: input.enableWebSearchTool
      ? async () => ({
          query: "fallback",
          provider: "test",
          searchedAt: "2026-07-07T10:00:00.000Z",
          results: [],
          truncated: false,
        })
      : undefined,
    loadPersonalizationSoul: async () => "",
    loadAppPreferences: async () => input.preferences,
    maybeCreateScaffoldForTurn: async (nextSession) => nextSession,
    hostedSystemPrompt: async (_base, _soul, _session, options) =>
      ["System prompt", options?.extraSystemContext].filter(Boolean).join("\n\n"),
    appendAssistantText: async (nextSession, turnId, text) => {
      events.push({
        id: `assistant_${events.length}`,
        sessionId: nextSession.id,
        turnId,
        name: "assistant.delta",
        timestamp: "2026-07-07T10:00:00.000Z",
        source: "provider",
        output: text,
      });
    },
    appendHostedContextUsage: async () => undefined,
    listIntegrationConnections: input.integrationConnections
      ? async () => ({
          teamId: null,
          connections: input.integrationConnections!,
        })
      : undefined,
    streamLocalByokChatTurn: async function* (streamInput) {
      streamInputs.push(streamInput);
      streamPass += 1;
      const requestTurn = turns.find((candidate) => candidate.id === streamInput.requestId);
      const requestSession = requestTurn?.sessionId ? sessions.get(requestTurn.sessionId) : null;
      await input.onStreamInput?.(streamInput, {
        streamPass,
        requestTurn,
        requestSession: requestSession ?? null,
        events,
        runs,
        injectedFlags,
      });
      const scriptedToolCall = await input.toolCallForStream?.(streamInput, {
        streamPass,
        requestTurn,
        requestSession: requestSession ?? null,
        events,
        runs,
        injectedFlags,
      });
      if (scriptedToolCall) {
        yield {
          toolCalls: [
            {
              index: 0,
              id: scriptedToolCall.id ?? `call_${scriptedToolCall.name}_${streamPass}`,
              type: "function",
              function: {
                name: scriptedToolCall.name,
                arguments: JSON.stringify(scriptedToolCall.args),
              },
            },
          ],
          raw: { pass: streamPass, scriptedToolCall: true },
        };
        yield { finishReason: "tool_calls", raw: { pass: streamPass, scriptedToolCall: true } };
        return;
      }
      const scripted = requestTurn?.sessionId
        ? input.textBySessionId?.[requestTurn.sessionId] ??
          (requestSession?.subagentRoleId ? input.textBySessionId?.[`role:${requestSession.subagentRoleId}`] : null)
        : null;
      if (scripted?.length) {
        const text = scripted.shift() ?? "";
        if (
          input.writeOnChildReport &&
          scripted.length === 0 &&
          requestSession?.subagentRoleId === input.writeOnChildReport.roleId
        ) {
          if (!requestSession.cwd) throw new Error("scripted child write is missing cwd");
          await writeFile(
            path.join(requestSession.cwd, input.writeOnChildReport.path),
            input.writeOnChildReport.content,
            "utf8",
          );
        }
        yield { text, raw: { pass: streamPass, scripted: true } };
        const usage = requestTurn?.sessionId ? input.usageBySessionId?.[requestTurn.sessionId] : null;
        if (usage) yield { usage, raw: { pass: streamPass, scripted: true, usage: true } };
        return;
      }
      if (!input.disableDefaultToolCall && streamPass === 1) {
        yield {
          toolCalls: [
            {
              index: 0,
              id: "call_subagent",
              type: "function",
              function: {
                name: input.toolName,
                arguments: JSON.stringify(input.toolArgs),
              },
            },
          ],
          raw: { pass: 1 },
        };
        yield { finishReason: "tool_calls", raw: { pass: 1 } };
        return;
      }
      yield { text: "Subagent tool handled.", raw: { pass: streamPass } };
      const usage = requestTurn?.sessionId ? input.usageBySessionId?.[requestTurn.sessionId] : null;
      if (usage) yield { usage, raw: { pass: streamPass, usage: true } };
    },
    turnFollowUpQueue,
    subagentQueue,
    notifySubagentRunStateChanged: input.notifySubagentRunStateChanged,
    enableGoalContinuations: false,
    maxHostedWorkspaceToolRounds: input.maxHostedWorkspaceToolRounds ?? 3,
    maxRepeatedInvalidToolRequests: 2,
  });

  return {
    runner,
    sessions,
    turns,
    events,
    approvals,
    runs,
    messages,
    usageRecords,
    workspaceRequests,
    sandboxForkRequests,
    sandboxCleanupRequests,
    streamInputs,
    subagentQueue,
    turnFollowUpQueue,
  };
}

export function git(cwd: string, args: string[]): void {
  const result = spawnSync("git", args, { cwd, encoding: "utf8" });
  if (result.status !== 0) {
    throw new Error(result.stderr.trim() || result.stdout.trim() || `git ${args.join(" ")} failed`);
  }
}

export async function withTimeout<T>(promise: Promise<T>, message: string, ms = 3000): Promise<T> {
  let timeout: ReturnType<typeof setTimeout> | null = null;
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_resolve, reject) => {
        timeout = setTimeout(() => reject(new Error(message)), ms);
      }),
    ]);
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}

export function preferences(patch: Record<string, unknown> = {}): AppPreferences {
  return AppPreferencesSchema.parse({
    defaultChatProvider: "openrouter",
    defaultChatModel: "test/model",
    defaultChatModelRef: { providerId: "openrouter", modelId: "test/model" },
    ...patch,
  });
}

export function preferencesWithSubagentRole(roleId: string, patch: Record<string, unknown>): AppPreferences {
  const base = preferences();
  return AppPreferencesSchema.parse({
    ...base,
    subagents: {
      ...base.subagents,
      roles: base.subagents.roles.map((role) => role.id === roleId ? { ...role, ...patch } : role),
    },
  });
}

export function turnFixture(overrides: Partial<Turn> = {}): Turn {
  return {
    id: "turn_fixture",
    sessionId: "session_1",
    providerTurnId: null,
    modelRef: { providerId: "openrouter", modelId: "test/model" },
    prompt: "Fixture turn",
    startedAt: "2026-07-07T09:00:00.000Z",
    completedAt: "2026-07-07T09:01:00.000Z",
    status: "completed",
    error: null,
    metadata: {},
    createPipelineRequest: null,
    createPipeline: null,
    ...overrides,
  };
}

export function usageRecord(patch: Partial<ModelUsageRecord>): ModelUsageRecord {
  const { attribution, ...rest } = patch;
  return ModelUsageRecordSchema.parse({
    id: "usage_record",
    requestId: "usage_record",
    requestOrdinal: 0,
    sessionId: "session_child",
    turnId: "turn_child",
    provider: "openrouter",
    model: "test/model",
    route: "local_byok",
    source: "provider_usage",
    requestKind: "subagent",
    visibility: "background",
    status: "completed",
    startedAt: "2026-07-07T09:00:01.000Z",
    completedAt: "2026-07-07T09:00:02.000Z",
    durationMs: 1000,
    firstTokenMs: 10,
    promptTokens: 20,
    completionTokens: 20,
    totalTokens: 40,
    errorType: null,
    errorMessage: null,
    attribution: {
      surface: "goal",
      workflowKind: "subagent",
      sessionId: "session_child",
      turnId: "turn_child",
      insightRunId: null,
      goalId: "goal_1",
      subagentRunId: "run_child",
      subagentRoleId: "research",
      createPipelineRequestId: null,
      createPipelineId: null,
      commandName: null,
      commandSource: null,
      appId: null,
      workspaceKind: "local_project",
      workspaceId: null,
      localProjectId: null,
      cloudProjectId: null,
      sourceEventSequence: null,
      ...(attribution ?? {}),
    },
    ...rest,
  });
}

export function activeGoalEvent(): RuntimeEvent {
  return {
    id: "goal_event",
    sessionId: "session_1",
    turnId: "turn_prior",
    name: "diagnostic",
    timestamp: "2026-07-07T09:59:00.000Z",
    source: "provider",
    status: "completed",
    output: "Ship subagent orchestration.",
    data: {
      kind: "thread_goal",
      provider: "openpond",
      goal: {
        id: "goal_1",
        provider: "openpond",
        objective: "Ship subagent orchestration.",
        status: "running",
        mode: "local",
        timeUsedSeconds: 20,
        tokensUsed: 100,
      },
    },
  };
}

export function baseSession(overrides: Partial<Session> = {}): Session {
  return {
    id: "session_1",
    provider: "openrouter",
    modelRef: { providerId: "openrouter", modelId: "test/model" },
    openPondCommandAccessMode: "ask",
    title: "BYOK chat",
    appId: null,
    appName: null,
    workspaceKind: "local_project",
    workspaceId: null,
    workspaceName: null,
    localProjectId: null,
    cloudProjectId: null,
    cloudTeamId: null,
    cwd: "/tmp/openpond",
    codexThreadId: null,
    createdAt: "2026-07-07T10:00:00.000Z",
    updatedAt: "2026-07-07T10:00:00.000Z",
    status: "idle",
    pinned: false,
    archived: false,
    order: 0,
    ...overrides,
  };
}
