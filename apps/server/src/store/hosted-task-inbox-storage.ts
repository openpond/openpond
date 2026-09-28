import { createHash, randomUUID } from "node:crypto";
import {
  SubagentRunSchema, TaskInboxSnapshotSchema, TaskInputSchema, TaskWaitSchema,
  type SubagentRun, type TaskInput, type TaskInputAdmission, type TaskInputMutation, type TaskWait,
} from "@openpond/contracts";
import {
  HOST_STORAGE_CONTRACT_VERSION, type AgentHostStorageClient,
} from "@openpond/agent-runtime";
import type { TaskInboxStorageParams } from "@openpond/agent-runtime";
import { z } from "zod";
import type { TaskInboxRepository } from "../runtime/task-inbox/repository.js";

const ok = z.object({ ok: z.literal(true) }).strict();
const inputs = z.array(TaskInputSchema);
const stringArray = z.array(z.string());
const completion = z.object({ turnId: z.string(), run: SubagentRunSchema }).strict();
const inputPage = z.object({ inputs: z.array(TaskInputSchema).max(10), hasMore: z.boolean() }).strict();
const waitPage = z.object({ items: z.array(TaskWaitSchema).max(10), hasMore: z.boolean() }).strict();
const wakePage = z.object({ items: z.array(z.string()).max(200), hasMore: z.boolean() }).strict();

function retryKey(action: string, value: unknown): string {
  return `inbox:${action}:${createHash("sha256").update(JSON.stringify(value)).digest("hex")}`;
}

/** Hosted transport for the same transactional domain port used by SQLite. */
export class HostedTaskInboxStorage implements TaskInboxRepository {
  constructor(private readonly client: AgentHostStorageClient) {}

  private async call<T>(params: TaskInboxStorageParams, schema: z.ZodType<T>, requestId: string = randomUUID()): Promise<T> {
    const result = await this.client.request({
      contractVersion: HOST_STORAGE_CONTRACT_VERSION,
      requestId,
      operation: "task-inbox/execute",
      params,
    });
    return schema.parse(result);
  }

  private async inputPages(makeParams: (afterSequence: number) => TaskInboxStorageParams, limit = Number.MAX_SAFE_INTEGER): Promise<TaskInput[]> {
    const result: TaskInput[] = [];
    let cursor = 0;
    while (result.length < limit) {
      const page = await this.call(makeParams(cursor), inputPage);
      for (const input of page.inputs) {
        if (input.sequence <= cursor) throw new Error("Host task input cursor did not advance.");
        cursor = input.sequence;
        result.push(input);
        if (result.length >= limit) break;
      }
      if (!page.hasMore) return result;
      if (page.inputs.length === 0) throw new Error("Host task input page made no progress.");
    }
    return result;
  }

  async recoverTaskInboxOwners(ownerId: string) {
    return this.call({ action: "recoverTaskInboxOwners", ownerId }, z.array(z.object({ sessionId: z.string(), turnId: z.string() }).strict()));
  }
  async hasTaskCompletion(turnId: string) { return this.call({ action: "hasTaskCompletion", turnId }, z.boolean()); }
  async taskInboxSnapshot(sessionId: string) {
    const snapshot = await this.call({ action: "taskInboxSnapshot", sessionId }, TaskInboxSnapshotSchema);
    const [inputs, waits] = await Promise.all([
      this.inputPages((afterSequence) => ({ action: "taskInboxSnapshotInputs", sessionId, afterSequence })),
      this.taskWaitsForSession(sessionId),
    ]);
    return { ...snapshot, inputs, waits };
  }
  async declareTaskWork(sessionId: string, turnId: string, ownerId: string, areas: string[]) {
    await this.call({ action: "declareTaskWork", sessionId, turnId, ownerId, areas }, ok);
  }
  async taskWorkAreas(sessionId: string) { return this.call({ action: "taskWorkAreas", sessionId }, stringArray); }
  async admitTaskInput(input: TaskInputAdmission) { return this.call({ action: "admitTaskInput", input }, TaskInputSchema); }
  async admitTaskInputs(input: TaskInputAdmission[]) { return this.call({ action: "admitTaskInputs", inputs: input }, inputs); }
  async rejectTaskInput(id: string, error: string) { await this.call({ action: "rejectTaskInput", id, error }, ok); }
  async getTaskInput(id: string) { return this.call({ action: "getTaskInput", id }, TaskInputSchema.nullable()); }
  async taskInputsForSession(sessionId: string, query: { afterSequence?: number; pendingOnly?: boolean; limit?: number } = {}) {
    const limit = Math.max(1, Math.min(500, query.limit ?? 128));
    const result: TaskInput[] = [];
    let cursor = query.afterSequence ?? 0;
    while (result.length < limit) {
      const requested = Math.min(10, limit - result.length);
      const page = await this.call({ action: "taskInputsForSession", sessionId,
        query: { afterSequence: cursor, pendingOnly: query.pendingOnly, limit: requested } }, inputs);
      if (!page.length) break;
      for (const input of page) {
        if (input.sequence <= cursor) throw new Error("Host task input cursor did not advance.");
        cursor = input.sequence;
        result.push(input);
      }
      if (page.length < requested) break;
    }
    return result;
  }
  async mutateTaskInput(sessionId: string, inputId: string, change: TaskInputMutation) {
    return this.call({ action: "mutateTaskInput", sessionId, inputId, change }, TaskInputSchema,
      retryKey("mutate", { sessionId, inputId, change }));
  }
  async openTaskInboxTurn(sessionId: string, turnId: string, ownerId: string) {
    await this.call({ action: "openTaskInboxTurn", sessionId, turnId, ownerId }, ok,
      retryKey("open", { sessionId, turnId, ownerId }));
  }
  async renewTaskInboxTurn(sessionId: string, turnId: string, ownerId: string) {
    await this.call({ action: "renewTaskInboxTurn", sessionId, turnId, ownerId }, ok);
  }
  async pendingTaskInputs(sessionId: string, turnId: string) {
    return this.inputPages((afterSequence) => ({ action: "pendingTaskInputs", sessionId, turnId, afterSequence }));
  }
  async taskAssignmentInputs(turnId: string) {
    return this.inputPages((afterSequence) => ({ action: "taskAssignmentInputs", turnId, afterSequence }));
  }
  async pauseTaskInboxTurn(sessionId: string, turnId: string, ownerId: string) {
    await this.call({ action: "pauseTaskInboxTurn", sessionId, turnId, ownerId }, ok);
  }
  async includeTaskInputs(sessionId: string, turnId: string, ownerId: string, requestId: string) {
    return this.call({ action: "includeTaskInputs", sessionId, turnId, ownerId, requestId }, inputs,
      retryKey("include", { sessionId, turnId, ownerId, requestId }));
  }
  async settleTaskInputRequest(requestId: string, outcome: "resolved" | "failed" | "replaced") {
    await this.call({ action: "settleTaskInputRequest", requestId, outcome }, ok);
  }
  async sealTaskInboxTurn(sessionId: string, turnId: string, ownerId: string) {
    return this.call({ action: "sealTaskInboxTurn", sessionId, turnId, ownerId }, z.boolean());
  }
  async sealNativeTaskInboxTurn(sessionId: string, turnId: string, ownerId: string) {
    return this.call({ action: "sealNativeTaskInboxTurn", sessionId, turnId, ownerId }, inputs);
  }
  async closeTaskInboxTurn(sessionId: string, turnId: string, ownerId: string, outcome: "completed" | "failed" | "interrupted") {
    await this.call({ action: "closeTaskInboxTurn", sessionId, turnId, ownerId, outcome }, ok);
  }
  async taskInboxPaused(sessionId: string) { return this.call({ action: "taskInboxPaused", sessionId }, z.boolean()); }
  async reserveTaskFollowup(sessionId: string, turnId: string, ownerId: string) {
    return this.call({ action: "reserveTaskFollowup", sessionId, turnId, ownerId }, TaskInputSchema.nullable(),
      retryKey("reserve", { sessionId, turnId, ownerId }));
  }
  async taskInboxWakeTargets() {
    const result: string[] = [];
    let cursor = "";
    while (true) {
      const page = await this.call({ action: "taskInboxWakeTargets", afterSessionId: cursor }, wakePage);
      for (const id of page.items) {
        if (id <= cursor) throw new Error("Host task wake cursor did not advance.");
        cursor = id;
        result.push(id);
      }
      if (!page.hasMore) return result;
      if (!page.items.length) throw new Error("Host task wake page made no progress.");
    }
  }
  async createTaskWait(value: TaskWait) { return this.call({ action: "createTaskWait", value }, TaskWaitSchema); }
  async settleTaskWait(id: string, state: TaskWait["state"]) { return this.call({ action: "settleTaskWait", id, state }, TaskWaitSchema); }
  async taskWaitsForSession(sessionId: string) {
    const result: TaskWait[] = [];
    let cursor = "";
    while (true) {
      const page = await this.call({ action: "taskWaitsForSession", sessionId, afterId: cursor }, waitPage);
      for (const wait of page.items) {
        if (wait.id <= cursor) throw new Error("Host task wait cursor did not advance.");
        cursor = wait.id;
        result.push(wait);
      }
      if (!page.hasMore) return result;
      if (!page.items.length) throw new Error("Host task wait page made no progress.");
    }
  }
  async commitSubagentCompletion(value: SubagentRun, turnId: string) {
    await this.call({ action: "commitSubagentCompletion", value, turnId }, ok);
  }
  async pendingTaskCompletions(afterTurnId = "") {
    const result: Array<{ turnId: string; run: SubagentRun }> = [];
    let cursor = afterTurnId;
    while (result.length < 100) {
      const page = await this.call({ action: "pendingTaskCompletions", afterTurnId: cursor }, z.array(completion).max(10));
      for (const item of page) {
        if (item.turnId <= cursor) throw new Error("Host task completion cursor did not advance.");
        cursor = item.turnId;
        result.push(item);
      }
      if (page.length < 10) break;
    }
    return result;
  }
  async settleTaskCompletion(turnId: string, inputId: string) {
    await this.call({ action: "settleTaskCompletion", turnId, inputId }, ok);
  }

  async upsertSubagentRun(value: SubagentRun): Promise<SubagentRun> {
    return this.call({ action: "upsertSubagentRun", value: SubagentRunSchema.parse(value) }, SubagentRunSchema);
  }

  async getSubagentRun(id: string): Promise<SubagentRun | null> {
    return this.call({ action: "getSubagentRun", id }, SubagentRunSchema.nullable());
  }

  async listSubagentRuns(query: {
    parentSessionId?: string | null; childSessionId?: string | null;
    status?: SubagentRun["status"] | readonly SubagentRun["status"][] | null;
    limit?: number;
  } = {}): Promise<SubagentRun[]> {
    const maximumScanned = 1_000;
    const runs: SubagentRun[] = [];
    let cursor = "";
    const statuses = query.status ? (Array.isArray(query.status) ? [...query.status] : [query.status]) : null;
    while (true) {
      const page = await this.call({ action: "listSubagentRuns", query: {
        parentSessionId: query.parentSessionId, childSessionId: query.childSessionId,
        status: statuses, afterId: cursor, limit: 10,
      } }, z.array(SubagentRunSchema).max(10));
      for (const run of page) {
        if (run.id <= cursor) throw new Error("Host subagent run cursor did not advance.");
        cursor = run.id;
        runs.push(run);
        if (runs.length > maximumScanned) {
          throw new Error("Hosted subagent run list exceeds 1,000 rows; use a narrower session or status query.");
        }
      }
      if (page.length < 10) break;
    }
    runs.sort((a, b) => (b.updatedAt ?? b.createdAt).localeCompare(a.updatedAt ?? a.createdAt));
    return query.limit === undefined ? runs : runs.slice(0, Math.max(1, Math.min(1_000, query.limit)));
  }

  async listActiveSubagentRuns(query: Parameters<HostedTaskInboxStorage["listSubagentRuns"]>[0] = {}): Promise<SubagentRun[]> {
    return this.listSubagentRuns({ ...query, status: query.status ?? ["queued", "running", "needs_resume"] });
  }
}
