import { randomUUID } from "node:crypto";
import { CronExpressionParser } from "cron-parser";
import type {
  ChatWorkflow,
  ChatWorkflowRun,
  CreateChatWorkflowRequest,
  SavedWorkRecurrence,
  Session,
  Turn,
  UpdateChatWorkflowRequest,
} from "@openpond/contracts";
import type { BackgroundWorkerQueue } from "../runtime/background-worker-queue.js";
import type { SqliteStore } from "../store/store.js";
import { now } from "../utils.js";

const DEFAULT_TICK_MS = 15_000;
const BUSY_RETRY_MS = 30_000;

type Logger = {
  warn(message: string, metadata?: Record<string, unknown>): void;
};

export type ChatWorkflowLoop = {
  start(): void;
  stop(): Promise<void>;
  create(input: CreateChatWorkflowRequest): Promise<ChatWorkflow>;
  list(sessionId?: string | null): Promise<ChatWorkflow[]>;
  listRuns(workflowId?: string | null): Promise<ChatWorkflowRun[]>;
  patch(id: string, input: UpdateChatWorkflowRequest): Promise<ChatWorkflow | null>;
  remove(id: string): Promise<boolean>;
  runNow(id: string): Promise<ChatWorkflowRun>;
};

export function createChatWorkflowLoop(options: {
  store: SqliteStore;
  queue: BackgroundWorkerQueue;
  getSession(sessionId: string): Promise<Session>;
  sendTurn(sessionId: string, payload: unknown): Promise<Turn>;
  isSessionTurnActive(sessionId: string): boolean;
  isClosing(): boolean;
  logger?: Logger;
  tickMs?: number;
}): ChatWorkflowLoop {
  const runningIds = new Set<string>();
  let interval: ReturnType<typeof setInterval> | null = null;
  let activeTick: Promise<void> | null = null;

  async function create(input: CreateChatWorkflowRequest): Promise<ChatWorkflow> {
    const session = await options.getSession(input.sessionId);
    const timestamp = now();
    const next = safeNextOccurrence(input.recurrence, new Date(), 0);
    if (!next.value) {
      throw new Error(next.error ?? "This workflow has no future occurrence.");
    }
    const workflow: ChatWorkflow = {
      id: randomUUID(),
      sessionId: session.id,
      sessionTitle: session.title,
      sourceTurnId: input.sourceTurnId ?? null,
      name: input.name,
      prompt: input.prompt,
      recurrence: input.recurrence,
      enabled: true,
      nextRunAt: next.value,
      lastRunAt: null,
      lastRunStatus: null,
      lastRunId: null,
      lastError: next.error,
      scheduledRunCount: 0,
      createdAt: timestamp,
      updatedAt: timestamp,
    };
    return options.store.upsertChatWorkflow(workflow);
  }

  async function runTick(): Promise<void> {
    if (options.isClosing()) return;
    const due = await options.store.listDueChatWorkflows(now());
    for (const workflow of due) {
      if (runningIds.has(workflow.id)) continue;
      if (options.isSessionTurnActive(workflow.sessionId)) {
        await options.store.patchChatWorkflow(workflow.id, (current) => ({
          ...current,
          nextRunAt: new Date(Date.now() + BUSY_RETRY_MS).toISOString(),
          lastError: "Waiting for the attached chat to finish its current turn.",
          updatedAt: now(),
        }));
        continue;
      }
      await enqueue(workflow, workflow.nextRunAt ?? now(), "schedule");
    }
  }

  function trackedTick(): Promise<void> {
    if (activeTick) return activeTick;
    const operation = runTick().finally(() => {
      if (activeTick === operation) activeTick = null;
    });
    activeTick = operation;
    return operation;
  }

  async function enqueue(
    workflow: ChatWorkflow,
    scheduledFor: string,
    trigger: ChatWorkflowRun["trigger"],
  ): Promise<ChatWorkflowRun> {
    const timestamp = now();
    const run: ChatWorkflowRun = {
      id: randomUUID(),
      workflowId: workflow.id,
      sessionId: workflow.sessionId,
      scheduledFor,
      trigger,
      status: "queued",
      turnId: null,
      error: null,
      createdAt: timestamp,
      startedAt: null,
      completedAt: null,
      updatedAt: timestamp,
    };
    const inserted = await options.store.insertChatWorkflowRun(run);
    runningIds.add(workflow.id);
    options.queue.enqueue(
      {
        label: "chat-workflow-run",
        metadata: {
          workflowId: workflow.id,
          sessionId: workflow.sessionId,
          trigger,
          scheduledFor,
        },
      },
      async () => {
        try {
          await execute(workflow, inserted);
        } finally {
          runningIds.delete(workflow.id);
        }
      },
    );
    return inserted;
  }

  async function execute(workflow: ChatWorkflow, run: ChatWorkflowRun) {
    const startedAt = now();
    await options.store.patchChatWorkflowRun(run.id, (current) => ({
      ...current,
      status: "running",
      startedAt,
      updatedAt: startedAt,
    }));
    let turn: Turn | null = null;
    let error: string | null = null;
    try {
      turn = await options.sendTurn(workflow.sessionId, {
        prompt: workflow.prompt,
        metadata: {
          interactionKind: "scheduled_workflow",
          chatWorkflowId: workflow.id,
          chatWorkflowName: workflow.name,
          chatWorkflowRunId: run.id,
          scheduledFor: run.scheduledFor,
        },
      });
    } catch (caught) {
      error = caught instanceof Error ? caught.message : String(caught);
    }
    const completedAt = now();
    const status = turn?.status === "completed" ? "succeeded" : "failed";
    await options.store.patchChatWorkflowRun(run.id, (current) => ({
      ...current,
      status,
      turnId: turn?.id ?? null,
      error: error ?? turn?.error ?? null,
      completedAt,
      updatedAt: completedAt,
    }));
    await options.store.patchChatWorkflow(workflow.id, (current) => {
      const scheduledRunCount =
        current.scheduledRunCount + (run.trigger === "schedule" ? 1 : 0);
      const next =
        run.trigger === "manual"
          ? { value: current.nextRunAt, error: null }
          : safeNextOccurrence(current.recurrence, new Date(), scheduledRunCount);
      return {
        ...current,
        enabled: next.value ? current.enabled : false,
        nextRunAt: current.enabled ? next.value : null,
        lastRunAt: completedAt,
        lastRunStatus: status,
        lastRunId: run.id,
        lastError: next.error ?? error ?? turn?.error ?? null,
        scheduledRunCount,
        updatedAt: completedAt,
      };
    });
  }

  return {
    start() {
      if (interval) return;
      void trackedTick().catch((error) =>
        options.logger?.warn("chat workflow tick failed", { error: String(error) }),
      );
      interval = setInterval(() => {
        void trackedTick().catch((error) =>
          options.logger?.warn("chat workflow tick failed", { error: String(error) }),
        );
      }, options.tickMs ?? DEFAULT_TICK_MS);
      interval.unref?.();
    },
    async stop() {
      if (interval) clearInterval(interval);
      interval = null;
      await activeTick?.catch(() => undefined);
    },
    create,
    list: (sessionId) => options.store.listChatWorkflows({ sessionId }),
    listRuns: (workflowId) => options.store.listChatWorkflowRuns(workflowId),
    async patch(id, input) {
      const existing = await options.store.getChatWorkflow(id);
      if (!existing) return null;
      const timestamp = now();
      if ("enabled" in input) {
        const next = input.enabled
          ? safeNextOccurrence(existing.recurrence, new Date(), existing.scheduledRunCount)
          : { value: null, error: null };
        return options.store.patchChatWorkflow(id, (current) => ({
          ...current,
          enabled: input.enabled && Boolean(next.value),
          nextRunAt: input.enabled ? next.value : null,
          lastError: next.error,
          updatedAt: timestamp,
        }));
      }
      const next = safeNextOccurrence(input.recurrence, new Date(), 0);
      return options.store.patchChatWorkflow(id, (current) => ({
        ...current,
        name: input.name,
        prompt: input.prompt,
        recurrence: input.recurrence,
        enabled: Boolean(next.value),
        nextRunAt: next.value,
        lastError: next.error,
        scheduledRunCount: 0,
        updatedAt: timestamp,
      }));
    },
    remove: (id) => options.store.deleteChatWorkflow(id),
    async runNow(id) {
      const workflow = await options.store.getChatWorkflow(id);
      if (!workflow) throw new Error("Chat workflow not found.");
      if (options.isSessionTurnActive(workflow.sessionId)) {
        throw new Error("The attached chat is currently running a turn.");
      }
      return enqueue(workflow, now(), "manual");
    },
  };
}

const WEEKDAY_NUMBER: Record<string, number> = {
  sunday: 0,
  monday: 1,
  tuesday: 2,
  wednesday: 3,
  thursday: 4,
  friday: 5,
  saturday: 6,
};

function safeNextOccurrence(
  recurrence: SavedWorkRecurrence,
  after: Date,
  scheduledRunCount: number,
): { value: string | null; error: string | null } {
  try {
    return {
      value: nextOccurrence(recurrence, after, scheduledRunCount),
      error: null,
    };
  } catch (error) {
    return {
      value: null,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

export function nextOccurrence(
  recurrence: SavedWorkRecurrence,
  after: Date,
  scheduledRunCount: number,
): string | null {
  if (
    recurrence.end.kind === "after_occurrences" &&
    scheduledRunCount >= recurrence.end.occurrences
  ) {
    return null;
  }
  const start = zonedLocalDateTime(
    recurrence.startDate,
    recurrence.localTime,
    recurrence.timeZone,
  );
  if (recurrence.kind === "once") {
    return start.getTime() > after.getTime() ? start.toISOString() : null;
  }
  const [hour, minute] = recurrence.localTime.split(":").map(Number);
  const expression =
    recurrence.kind === "daily"
      ? `${minute} ${hour} * * *`
      : recurrence.kind === "weekdays"
        ? `${minute} ${hour} * * 1-5`
        : recurrence.kind === "weekly"
          ? `${minute} ${hour} * * ${(recurrence.weekdays ?? [])
              .map((day) => WEEKDAY_NUMBER[day])
              .join(",")}`
          : `${minute} ${hour} ${recurrence.dayOfMonth} * *`;
  const currentDate = new Date(
    Math.max(after.getTime(), start.getTime() - 1_000),
  );
  const candidate = CronExpressionParser.parse(expression, {
    currentDate,
    tz: recurrence.timeZone,
  })
    .next()
    .toDate();
  if (recurrence.end.kind === "on_date") {
    const end = zonedLocalDateTime(
      recurrence.end.date,
      "23:59",
      recurrence.timeZone,
    );
    if (candidate.getTime() > end.getTime() + 59_999) return null;
  }
  return candidate.toISOString();
}

function zonedLocalDateTime(date: string, time: string, timeZone: string): Date {
  const [year, month, day] = date.split("-").map(Number);
  const [hour, minute] = time.split(":").map(Number);
  const utcGuess = Date.UTC(year!, month! - 1, day!, hour!, minute!);
  let candidate = new Date(utcGuess);
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const parts = new Intl.DateTimeFormat("en-CA", {
      timeZone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23",
    }).formatToParts(candidate);
    const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
    const represented = Date.UTC(
      Number(values.year),
      Number(values.month) - 1,
      Number(values.day),
      Number(values.hour),
      Number(values.minute),
    );
    const adjustment = utcGuess - represented;
    if (adjustment === 0) return candidate;
    candidate = new Date(candidate.getTime() + adjustment);
  }
  return candidate;
}
