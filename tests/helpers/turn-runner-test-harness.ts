import {
  emptyOpenPondProfileState,
  type Approval,
  type ModelUsageRecord,
  type RuntimeEvent,
  type Session,
  type SubagentMessage,
  type SubagentRun,
  type Turn,
} from "../../packages/contracts/src";
import { createBackgroundWorkerQueue } from "../../apps/server/src/runtime/background-worker-queue";
import { createTurnRunner } from "../../apps/server/src/runtime/turn-runner";

export type TurnRunnerTestDependencies = Parameters<typeof createTurnRunner>[0];
export type TurnRunnerTestDependencyOverrides = Partial<Omit<TurnRunnerTestDependencies, "store">> & {
  store?: Partial<TurnRunnerTestDependencies["store"]>;
};

export type TurnRunnerTestState = {
  sessions: Map<string, Session>;
  turns: Turn[];
  events: RuntimeEvent[];
  approvals: Approval[];
  usageRecords: ModelUsageRecord[];
  subagentRuns: SubagentRun[];
  subagentMessages: SubagentMessage[];
  streamInputs: Array<Record<string, unknown>>;
};

export function withTurnRunnerTestStore<
  T extends Pick<
    TurnRunnerTestDependencies["store"],
    | "getTurn"
    | "insertTurn"
    | "updateTurn"
    | "getApproval"
  > & {
    snapshot(): Promise<{ events: RuntimeEvent[]; turns: Turn[]; approvals?: Approval[] }>;
  },
>(store: T): T & TurnRunnerTestDependencies["store"] {
  return {
    ...store,
    async runtimeEventsForSession(sessionId, query = {}) {
      const snapshot = await store.snapshot();
      return snapshot.events
        .map((runtimeEvent, index) => ({
          ...runtimeEvent,
          sequence: runtimeEvent.sequence ?? index + 1,
        }))
        .filter((runtimeEvent) => {
          if (runtimeEvent.sessionId !== sessionId) return false;
          if (query.afterSequence !== undefined && query.afterSequence !== null) {
            if ((runtimeEvent.sequence ?? 0) <= query.afterSequence) return false;
          }
          if (query.names?.length && !query.names.includes(runtimeEvent.name)) return false;
          return true;
        })
        .slice(0, query.limit ?? undefined);
    },
    async latestAssistantTextForSession(sessionId) {
      const snapshot = await store.snapshot();
      return snapshot.events.findLast((runtimeEvent) =>
        runtimeEvent.sessionId === sessionId &&
        runtimeEvent.name === "assistant.delta" &&
        Boolean(runtimeEvent.output?.trim())
      )?.output?.trim() ?? null;
    },
    async currentOpenPondThreadGoal(sessionId) {
      return currentGoalFromEvents((await store.snapshot()).events, sessionId);
    },
    async openPondThreadGoalById(sessionId, goalId) {
      return goalFromEvents((await store.snapshot()).events, sessionId, goalId);
    },
    async latestTurnForSession(sessionId, status) {
      return (await store.snapshot()).turns.findLast((turn) =>
        turn.sessionId === sessionId && (!status || turn.status === status)
      ) ?? null;
    },
    async latestPersistedTurnForSession(sessionId, status) {
      return (await store.snapshot()).turns.findLast((turn) =>
        turn.sessionId === sessionId && (!status || turn.status === status)
      ) ?? null;
    },
    async countTurnsForSession(sessionId) {
      return (await store.snapshot()).turns.filter((turn) => turn.sessionId === sessionId).length;
    },
    async hasSubagentParentWakeTurn(sessionId, messageId) {
      return (await store.snapshot()).turns.some((turn) =>
        turn.sessionId === sessionId &&
        nestedString(turn.metadata, "subagentParentWake", "messageId") === messageId
      );
    },
    async countSubagentParentWakeTurns(sessionId, fromRunId) {
      return (await store.snapshot()).turns.filter((turn) =>
        turn.sessionId === sessionId &&
        nestedString(turn.metadata, "subagentParentWake", "fromRunId") === fromRunId
      ).length;
    },
  } as T & TurnRunnerTestDependencies["store"];
}

const TEST_NOW = "2026-07-09T12:00:00.000Z";

export function turnRunnerTestSession(overrides: Partial<Session> = {}): Session {
  return {
    id: "session_test",
    provider: "openrouter",
    modelRef: { providerId: "openrouter", modelId: "test/model" },
    title: "Turn runner characterization",
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
    createdAt: TEST_NOW,
    updatedAt: TEST_NOW,
    status: "idle",
    pinned: false,
    archived: false,
    order: 0,
    ...overrides,
  };
}

export function createTurnRunnerTestHarness(options: {
  sessions?: Session[];
  turns?: Turn[];
  events?: RuntimeEvent[];
  approvals?: Approval[];
  usageRecords?: ModelUsageRecord[];
  subagentRuns?: SubagentRun[];
  subagentMessages?: SubagentMessage[];
  dependencies?: TurnRunnerTestDependencyOverrides;
} = {}) {
  const sessions = new Map(
    (options.sessions ?? [turnRunnerTestSession()]).map((session) => [session.id, session]),
  );
  const state: TurnRunnerTestState = {
    sessions,
    turns: [...(options.turns ?? [])],
    events: [...(options.events ?? [])],
    approvals: [...(options.approvals ?? [])],
    usageRecords: [...(options.usageRecords ?? [])],
    subagentRuns: [...(options.subagentRuns ?? [])],
    subagentMessages: [...(options.subagentMessages ?? [])],
    streamInputs: [],
  };

  const defaultStore: TurnRunnerTestDependencies["store"] = {
    async runtimeEventsForSession(sessionId, query = {}) {
      return state.events.map((runtimeEvent, index) => ({
        ...runtimeEvent,
        sequence: runtimeEvent.sequence ?? index + 1,
      })).filter((runtimeEvent) => {
        if (runtimeEvent.sessionId !== sessionId) return false;
        if (query.afterSequence !== undefined && query.afterSequence !== null) {
          if ((runtimeEvent.sequence ?? 0) <= query.afterSequence) return false;
        }
        if (query.names?.length && !query.names.includes(runtimeEvent.name)) return false;
        return true;
      }).slice(0, query.limit ?? undefined);
    },
    async latestAssistantTextForSession(sessionId) {
      return state.events.findLast((runtimeEvent) =>
        runtimeEvent.sessionId === sessionId &&
        runtimeEvent.name === "assistant.delta" &&
        Boolean(runtimeEvent.output?.trim())
      )?.output?.trim() ?? null;
    },
    async currentOpenPondThreadGoal(sessionId) {
      return currentGoalFromEvents(state.events, sessionId);
    },
    async openPondThreadGoalById(sessionId, goalId) {
      return goalFromEvents(state.events, sessionId, goalId);
    },
    async latestTurnForSession(sessionId, status) {
      return state.turns.findLast((turn) =>
        turn.sessionId === sessionId && (!status || turn.status === status)
      ) ?? null;
    },
    async latestPersistedTurnForSession(sessionId, status) {
      return state.turns.findLast((turn) =>
        turn.sessionId === sessionId && (!status || turn.status === status)
      ) ?? null;
    },
    async countTurnsForSession(sessionId) {
      return state.turns.filter((turn) => turn.sessionId === sessionId).length;
    },
    async hasSubagentParentWakeTurn(sessionId, messageId) {
      return state.turns.some((turn) =>
        turn.sessionId === sessionId &&
        nestedString(turn.metadata, "subagentParentWake", "messageId") === messageId
      );
    },
    async countSubagentParentWakeTurns(sessionId, fromRunId) {
      return state.turns.filter((turn) =>
        turn.sessionId === sessionId &&
        nestedString(turn.metadata, "subagentParentWake", "fromRunId") === fromRunId
      ).length;
    },
    async getTurn(turnId) {
      return state.turns.find((turn) => turn.id === turnId) ?? null;
    },
    async insertTurn(turn) {
      state.turns.push(turn);
    },
    async updateTurn(turnId, updater) {
      const index = state.turns.findIndex((turn) => turn.id === turnId);
      if (index < 0) return null;
      state.turns[index] = updater(state.turns[index]!);
      return state.turns[index]!;
    },
    async getApproval(approvalId) {
      return state.approvals.find((approval) => approval.id === approvalId) ?? null;
    },
    async upsertModelUsageRecord(record) {
      upsertById(state.usageRecords, record, (candidate) => candidate.requestId);
      return record;
    },
    async listModelUsageRecords() {
      return state.usageRecords;
    },
    async upsertSubagentRun(run) {
      upsertById(state.subagentRuns, run, (candidate) => candidate.id);
      return run;
    },
    async getSubagentRun(runId) {
      return state.subagentRuns.find((run) => run.id === runId) ?? null;
    },
    async listSubagentRuns() {
      return state.subagentRuns;
    },
    async listActiveSubagentRuns() {
      return state.subagentRuns.filter((run) =>
        ["queued", "running", "needs_resume"].includes(run.status),
      );
    },
    async listStaleSubagentRuns() {
      return [];
    },
    async appendSubagentMessage(message) {
      state.subagentMessages.push(message);
      return message;
    },
    async listSubagentMessages() {
      return state.subagentMessages;
    },
  };

  const defaults: TurnRunnerTestDependencies = {
    attachmentRootDir: "/tmp/openpond-turn-runner-characterization",
    store: defaultStore,
    upsertApproval: async (approval) => {
      upsertById(state.approvals, approval, (candidate) => candidate.id);
    },
    getSession: async (sessionId) => {
      const session = state.sessions.get(sessionId);
      if (!session) throw new Error(`Unknown test session ${sessionId}`);
      return session;
    },
    updateSession: async (sessionId, patch) => {
      const session = state.sessions.get(sessionId);
      if (!session) throw new Error(`Unknown test session ${sessionId}`);
      const updated = { ...session, ...patch };
      state.sessions.set(sessionId, updated);
      return updated;
    },
    completeTurn: async (sessionId, turnId, providerTurnId = null) => {
      const turn = requiredTurn(state.turns, turnId);
      Object.assign(turn, { providerTurnId, status: "completed", completedAt: TEST_NOW });
      updateSessionStatus(state.sessions, sessionId, "idle");
      return turn;
    },
    failTurn: async (session, turnId, message) => {
      const turn = requiredTurn(state.turns, turnId);
      Object.assign(turn, { status: "failed", error: message, completedAt: TEST_NOW });
      updateSessionStatus(state.sessions, session.id, "idle");
      return turn;
    },
    interruptTurn: async (session, turnId, message = "Stopped by user") => {
      const turn = requiredTurn(state.turns, turnId);
      Object.assign(turn, { status: "interrupted", error: message, completedAt: TEST_NOW });
      updateSessionStatus(state.sessions, session.id, "idle");
      return turn;
    },
    defaultSessionCwd: () => "/tmp/openpond",
    findOpenPondApp: async () => {
      throw new Error("App lookup was not configured for this turn-runner test");
    },
    resolveSessionWorkspaceCwd: async () => null,
    ensureCodexRuntime: async () => {
      throw new Error("Codex runtime was not configured for this turn-runner test");
    },
    appendWorkspaceDiffEvent: async () => undefined,
    workspaceDiffBaseline: async () => null,
    appendRuntimeEvent: async (runtimeEvent) => {
      state.events.push(runtimeEvent);
    },
    executeWorkspaceTool: async () => {
      throw new Error("Workspace tools were not configured for this turn-runner test");
    },
    loadOpenPondProfileState: async () => emptyOpenPondProfileState(),
    loadPersonalizationSoul: async () => "",
    maybeCreateScaffoldForTurn: async (session) => session,
    hostedSystemPrompt: async () => "System prompt",
    appendAssistantText: async (session, turnId, output) => {
      state.events.push({
        id: `assistant_${state.events.length + 1}`,
        sessionId: session.id,
        turnId,
        name: "assistant.delta",
        timestamp: TEST_NOW,
        source: "provider",
        output,
      });
    },
    appendHostedContextUsage: async () => undefined,
    streamLocalByokChatTurn: async function* (input) {
      state.streamInputs.push(input as unknown as Record<string, unknown>);
      yield { text: "Characterized response.", raw: { kind: "characterized" } };
    },
    turnFollowUpQueue: createBackgroundWorkerQueue({ queueId: "turn-runner-characterization" }),
    subagentQueue: createBackgroundWorkerQueue({ queueId: "subagent-characterization" }),
    enableGoalContinuations: false,
    maxHostedWorkspaceToolRounds: 3,
    maxRepeatedInvalidToolRequests: 2,
  };

  const dependencies: TurnRunnerTestDependencies = {
    ...defaults,
    ...options.dependencies,
    store: {
      ...defaultStore,
      ...options.dependencies?.store,
    },
  };
  return {
    runner: createTurnRunner(dependencies),
    dependencies,
    state,
  };
}

export function normalizeRuntimeEventTrace(events: RuntimeEvent[]): Array<Record<string, unknown>> {
  return events.map((runtimeEvent) => {
    const normalized = normalizeVolatileValues(runtimeEvent) as Record<string, unknown>;
    delete normalized.id;
    delete normalized.timestamp;
    return normalized;
  });
}

function normalizeVolatileValues(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(normalizeVolatileValues);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>).map(([key, item]) => {
      if (key === "createdAt" || key === "updatedAt" || key === "completedAt" || key === "startedAt") {
        return [key, "<timestamp>"];
      }
      if (/^(id|turnId|requestId|goalId|runId|approvalId)$/i.test(key) && typeof item === "string") {
        return [key, `<${key}>`];
      }
      return [key, normalizeVolatileValues(item)];
    }),
  );
}

function upsertById<T>(items: T[], next: T, id: (item: T) => string): void {
  const index = items.findIndex((candidate) => id(candidate) === id(next));
  if (index < 0) items.push(next);
  else items[index] = next;
}

function requiredTurn(turns: Turn[], turnId: string): Turn {
  const turn = turns.find((candidate) => candidate.id === turnId);
  if (!turn) throw new Error(`Unknown test turn ${turnId}`);
  return turn;
}

function updateSessionStatus(
  sessions: Map<string, Session>,
  sessionId: string,
  status: Session["status"],
): void {
  const session = sessions.get(sessionId);
  if (session) sessions.set(sessionId, { ...session, status });
}

function currentGoalFromEvents(events: RuntimeEvent[], sessionId: string): Record<string, unknown> | null {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const runtimeEvent = events[index]!;
    if (runtimeEvent.sessionId !== sessionId || runtimeEvent.name !== "diagnostic") continue;
    const data = objectRecord(runtimeEvent.data);
    if (data?.kind === "thread_goal_cleared") return null;
    if (data?.kind !== "thread_goal") continue;
    const goal = objectRecord(data.goal);
    const status = typeof goal?.status === "string" ? goal.status : "active";
    if (["completed", "complete", "failed", "cancelled", "stopped"].includes(status)) return null;
    return goal;
  }
  return null;
}

function goalFromEvents(
  events: RuntimeEvent[],
  sessionId: string,
  goalId: string,
): Record<string, unknown> | null {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const runtimeEvent = events[index]!;
    if (runtimeEvent.sessionId !== sessionId || runtimeEvent.name !== "diagnostic") continue;
    const data = objectRecord(runtimeEvent.data);
    const goal = objectRecord(data?.goal);
    if (goal?.id === goalId) return goal;
  }
  return null;
}

function nestedString(
  value: unknown,
  objectKey: string,
  stringKey: string,
): string | null {
  const nested = objectRecord(objectRecord(value)?.[objectKey]);
  return typeof nested?.[stringKey] === "string" ? nested[stringKey] : null;
}

function objectRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}
