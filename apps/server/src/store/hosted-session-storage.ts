import { randomUUID } from "node:crypto";
import { SessionSchema, TurnSchema, type Session, type Turn } from "@openpond/contracts";
import {
  HOST_STORAGE_CONTRACT_VERSION,
  type AgentHostStorageClient,
} from "@openpond/agent-runtime";
import { z } from "zod";

const storedSessionSchema = z.object({
  revision: z.number().int().min(1),
  session: SessionSchema,
}).strict();
const storedTurnSchema = z.object({
  revision: z.number().int().min(1),
  turn: TurnSchema,
}).strict();
const sessionPageSchema = z.object({
  sessions: z.array(SessionSchema).max(200),
  nextAfterId: z.string().min(1).nullable(),
}).strict();
const turnPageSchema = z.object({
  turns: z.array(TurnSchema).max(200),
  nextBeforeSortIndex: z.number().int().nonnegative().nullable(),
}).strict();

/** Typed session operations; the host owns authorization, revisions and retries. */
export class HostedSessionStorage {
  constructor(private readonly client: AgentHostStorageClient) {}

  async count(): Promise<number> {
    const value = await this.client.request({
      contractVersion: HOST_STORAGE_CONTRACT_VERSION,
      requestId: randomUUID(),
      operation: "session/count",
      params: {},
    });
    return z.object({ count: z.number().int().nonnegative() }).strict().parse(value).count;
  }

  async get(sessionId: string): Promise<{ session: Session; revision: number } | null> {
    const value = await this.client.request({
      contractVersion: HOST_STORAGE_CONTRACT_VERSION,
      requestId: randomUUID(),
      operation: "session/get",
      params: { sessionId },
    });
    return value === null ? null : storedSessionSchema.parse(value);
  }

  async sessionCount(): Promise<number> { return this.count(); }

  async sessionShells(): Promise<Session[]> {
    const sessions: Session[] = [];
    let afterId: string | null = null;
    do {
      const page = sessionPageSchema.parse(await this.client.request({
        contractVersion: HOST_STORAGE_CONTRACT_VERSION,
        requestId: randomUUID(),
        operation: "session/page",
        params: { afterId, limit: Math.min(10, 1_001 - sessions.length) },
      }));
      sessions.push(...page.sessions);
      if (sessions.length > 1_000) throw new Error("Hosted session list exceeds 1,000 rows; use a scoped page query.");
      if (page.nextAfterId !== null && (page.sessions.length === 0 ||
          (afterId !== null && page.nextAfterId <= afterId))) {
        throw new Error("Host session cursor did not advance.");
      }
      afterId = page.nextAfterId;
    } while (afterId !== null);
    return sessions;
  }

  async getSession(sessionId: string): Promise<Session | null> {
    return (await this.get(sessionId))?.session ?? null;
  }

  async insertSessionAtFront(session: Session): Promise<void> {
    await this.put({ session, expectedRevision: null, requestId: randomUUID() });
  }

  async updateSession(sessionId: string, updater: (session: Session) => Session): Promise<Session | null> {
    const current = await this.get(sessionId);
    if (!current) return null;
    const next = SessionSchema.parse(updater(current.session));
    if (next.id !== sessionId) throw new Error("A session update cannot change its identity.");
    return (await this.put({ session: next, expectedRevision: current.revision, requestId: randomUUID() })).session;
  }

  async put(input: {
    session: Session;
    expectedRevision: number | null;
    requestId: string;
  }): Promise<{ session: Session; revision: number }> {
    const session = SessionSchema.parse(input.session);
    return storedSessionSchema.parse(await this.client.request({
      contractVersion: HOST_STORAGE_CONTRACT_VERSION,
      requestId: input.requestId,
      operation: "session/put",
      params: { sessionId: session.id, expectedRevision: input.expectedRevision, session },
    }));
  }

  async readTurn(turnId: string): Promise<{ turn: Turn; revision: number } | null> {
    const value = await this.client.request({
      contractVersion: HOST_STORAGE_CONTRACT_VERSION,
      requestId: randomUUID(),
      operation: "turn/get",
      params: { turnId },
    });
    return value === null ? null : storedTurnSchema.parse(value);
  }

  async getTurn(turnId: string): Promise<Turn | null> {
    return (await this.readTurn(turnId))?.turn ?? null;
  }

  async turnsForSession(sessionId: string, limit = 50): Promise<Turn[]> {
    const maximum = Math.max(1, Math.min(1_000, Math.trunc(limit)));
    const turns: Turn[] = [];
    let beforeSortIndex: number | null = null;
    while (turns.length < maximum) {
      const page = turnPageSchema.parse(await this.client.request({
        contractVersion: HOST_STORAGE_CONTRACT_VERSION,
        requestId: randomUUID(),
        operation: "turn/page",
        params: { sessionId, beforeSortIndex, limit: Math.min(200, maximum - turns.length) },
      }));
      turns.push(...page.turns);
      if (page.nextBeforeSortIndex === null) break;
      if (beforeSortIndex !== null && page.nextBeforeSortIndex >= beforeSortIndex) {
        throw new Error("Host turn cursor did not advance.");
      }
      beforeSortIndex = page.nextBeforeSortIndex;
    }
    return turns;
  }

  async countTurnsForSession(sessionId: string): Promise<number> {
    const value = await this.client.request({
      contractVersion: HOST_STORAGE_CONTRACT_VERSION,
      requestId: randomUUID(),
      operation: "turn/count",
      params: { sessionId },
    });
    return z.object({ count: z.number().int().nonnegative() }).strict().parse(value).count;
  }

  async hasSubagentParentWakeTurn(sessionId: string, messageId: string): Promise<boolean> {
    return (await this.wakeCount(sessionId, "messageId", messageId)) > 0;
  }

  async countSubagentParentWakeTurns(sessionId: string, fromRunId: string): Promise<number> {
    return this.wakeCount(sessionId, "fromRunId", fromRunId);
  }

  async latestAssistantTextForSession(sessionId: string): Promise<string | null> {
    const value = await this.client.request({
      contractVersion: HOST_STORAGE_CONTRACT_VERSION,
      requestId: randomUUID(),
      operation: "events/latestAssistantText",
      params: { sessionId },
    });
    return z.object({ text: z.string().nullable() }).strict().parse(value).text;
  }

  private async wakeCount(sessionId: string, key: "messageId" | "fromRunId", value: string): Promise<number> {
    const response = await this.client.request({
      contractVersion: HOST_STORAGE_CONTRACT_VERSION,
      requestId: randomUUID(),
      operation: "turn/wakeCount",
      params: { sessionId, key, value },
    });
    return z.object({ count: z.number().int().nonnegative() }).strict().parse(response).count;
  }

  async latestTurnForSession(sessionId: string, status?: Turn["status"]): Promise<Turn | null> {
    const value = await this.client.request({
      contractVersion: HOST_STORAGE_CONTRACT_VERSION,
      requestId: randomUUID(),
      operation: "turn/latest",
      params: { sessionId, status: status ?? null },
    });
    return value === null ? null : TurnSchema.parse(value);
  }

  /** The host read is already committed and is not blocked by a local write queue. */
  async latestPersistedTurnForSession(sessionId: string, status?: Turn["status"]): Promise<Turn | null> {
    return this.latestTurnForSession(sessionId, status);
  }

  async insertTurn(turn: Turn): Promise<void> {
    await this.putTurn({ turn, expectedRevision: null, requestId: randomUUID() });
  }

  async updateTurn(turnId: string, updater: (turn: Turn) => Turn): Promise<Turn | null> {
    const current = await this.readTurn(turnId);
    if (!current) return null;
    const next = TurnSchema.parse(updater(current.turn));
    if (next.id !== turnId || next.sessionId !== current.turn.sessionId) {
      throw new Error("A turn update cannot change its identity.");
    }
    return (await this.putTurn({ turn: next, expectedRevision: current.revision, requestId: randomUUID() })).turn;
  }

  async putTurn(input: {
    turn: Turn;
    expectedRevision: number | null;
    requestId: string;
  }): Promise<{ turn: Turn; revision: number }> {
    const turn = TurnSchema.parse(input.turn);
    return storedTurnSchema.parse(await this.client.request({
      contractVersion: HOST_STORAGE_CONTRACT_VERSION,
      requestId: input.requestId,
      operation: "turn/put",
      params: { sessionId: turn.sessionId, turnId: turn.id, expectedRevision: input.expectedRevision, turn },
    }));
  }
}
