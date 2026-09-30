import { createHash } from "node:crypto";
import type { Approval, CreateImproveRun, CreateImproveRunAction, ModelUsageRecord,
  RuntimeEvent, Session, Turn } from "@openpond/contracts";
import type { AgentHostStorageClient } from "@openpond/agent-runtime";
import type { AppServerRuntimeCoreStorage } from "../app-server-runtime.js";
import type { TurnRepository } from "../runtime/turns/ports.js";
import { HostedApprovalStorage, HostedModelUsageStorage } from "./hosted-approval-usage-storage.js";
import { HostedCreateImproveStorage } from "./hosted-create-improve-storage.js";
import { HostedRuntimeEventStorage } from "./hosted-runtime-event-storage.js";
import { HostedSessionStorage } from "./hosted-session-storage.js";
import { HostedTaskInboxStorage } from "./hosted-task-inbox-storage.js";

/** One typed repository for a hosted turn. No method reads a local SQLite file. */
export class HostedTurnRepository extends HostedTaskInboxStorage implements TurnRepository {
  private readonly sessions: HostedSessionStorage;
  private readonly events: HostedRuntimeEventStorage;
  private readonly approvals: HostedApprovalStorage;
  private readonly usage: HostedModelUsageStorage;
  private readonly createImprove: HostedCreateImproveStorage;

  constructor(client: AgentHostStorageClient) {
    super(client);
    this.sessions = new HostedSessionStorage(client);
    this.events = new HostedRuntimeEventStorage(client);
    this.approvals = new HostedApprovalStorage(client);
    this.usage = new HostedModelUsageStorage(client);
    this.createImprove = new HostedCreateImproveStorage(client);
  }

  sessionShells(): Promise<Session[]> { return this.sessions.sessionShells(); }
  sessionCount(): Promise<number> { return this.sessions.sessionCount(); }
  getSession(id: string): Promise<Session | null> { return this.sessions.getSession(id); }
  insertSessionAtFront(session: Session): Promise<void> { return this.sessions.insertSessionAtFront(session); }
  updateSession(id: string, updater: (session: Session) => Session): Promise<Session | null> {
    return this.sessions.updateSession(id, updater);
  }
  getTurn(id: string): Promise<Turn | null> { return this.sessions.getTurn(id); }
  insertTurn(turn: Turn): Promise<void> { return this.sessions.insertTurn(turn); }
  updateTurn(id: string, updater: (turn: Turn) => Turn): Promise<Turn | null> {
    return this.sessions.updateTurn(id, updater);
  }
  latestTurnForSession(id: string, status?: Turn["status"]): Promise<Turn | null> {
    return this.sessions.latestTurnForSession(id, status);
  }
  latestPersistedTurnForSession(id: string, status?: Turn["status"]): Promise<Turn | null> {
    return this.sessions.latestPersistedTurnForSession(id, status);
  }
  turnsForSession(id: string, limit?: number): Promise<Turn[]> { return this.sessions.turnsForSession(id, limit); }
  countTurnsForSession(id: string): Promise<number> { return this.sessions.countTurnsForSession(id); }
  hasSubagentParentWakeTurn(id: string, messageId: string): Promise<boolean> {
    return this.sessions.hasSubagentParentWakeTurn(id, messageId);
  }
  countSubagentParentWakeTurns(id: string, fromRunId: string): Promise<number> {
    return this.sessions.countSubagentParentWakeTurns(id, fromRunId);
  }
  latestAssistantTextForSession(id: string): Promise<string | null> {
    return this.sessions.latestAssistantTextForSession(id);
  }
  appendRuntimeEvent(event: RuntimeEvent): Promise<RuntimeEvent> { return this.events.appendRuntimeEvent(event); }
  runtimeEventsForSession(id: string, query?: {
    afterSequence?: number | null; names?: readonly RuntimeEvent["name"][]; limit?: number | null;
    excludeReasoningDeltas?: boolean;
  }): Promise<RuntimeEvent[]> { return this.events.runtimeEventsForSession(id, query); }
  persistedRuntimeEventsForSession(id: string, query?: {
    afterSequence?: number | null; names?: readonly RuntimeEvent["name"][]; limit?: number | null;
    excludeReasoningDeltas?: boolean;
  }): Promise<RuntimeEvent[]> { return this.events.persistedRuntimeEventsForSession(id, query); }
  async runtimeEventsForTurn(id: string, query?: {
    names?: readonly RuntimeEvent["name"][]; limit?: number | null;
  }): Promise<RuntimeEvent[]> {
    const turn = await this.getTurn(id);
    if (!turn) return [];
    const events = (await this.events.runtimeEventsForSession(turn.sessionId))
      .filter(event => event.turnId === id && (!query?.names || query.names.includes(event.name)));
    return query?.limit == null ? events : events.slice(0, Math.max(0, query.limit));
  }
  runtimeEventPageRows(input: {
    sessionId: string | null; afterSequence: number; beforeSequence: number | null; limit: number;
  }) { return this.events.runtimeEventPageRows(input); }
  getApproval(id: string): Promise<Approval | null> { return this.approvals.getApproval(id); }
  async upsertApproval(approval: Approval): Promise<void> {
    const current = await this.approvals.readApproval(approval.id);
    if (current && JSON.stringify(current.approval) === JSON.stringify(approval)) return;
    await this.approvals.putApproval({ approval, expectedRevision: current?.revision ?? null,
      requestId: `approval:${createHash("sha256").update(JSON.stringify({ approval, revision: current?.revision ?? null })).digest("hex")}` });
  }
  upsertModelUsageRecord(record: ModelUsageRecord): Promise<ModelUsageRecord> {
    return this.usage.upsertModelUsageRecord(record);
  }
  listModelUsageRecords(query?: Parameters<HostedModelUsageStorage["listModelUsageRecords"]>[0]): Promise<ModelUsageRecord[]> {
    return this.usage.listModelUsageRecords(query);
  }
  getCreateImproveRun(id: string): Promise<CreateImproveRun | null> { return this.createImprove.getCreateImproveRun(id); }
  listCreateImproveRuns(query?: Parameters<HostedCreateImproveStorage["listCreateImproveRuns"]>[0]): Promise<CreateImproveRun[]> {
    return this.createImprove.listCreateImproveRuns(query);
  }
  upsertCreateImproveRun(run: CreateImproveRun): Promise<CreateImproveRun> {
    return this.createImprove.upsertCreateImproveRun(run);
  }
  mutateCreateImproveRun(action: CreateImproveRunAction, updater: (run: CreateImproveRun) => CreateImproveRun) {
    return this.createImprove.mutateCreateImproveRun(action, updater);
  }
}

export function createHostedRuntimeCoreStorage(client: AgentHostStorageClient): AppServerRuntimeCoreStorage {
  return new HostedTurnRepository(client);
}
