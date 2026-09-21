import { randomUUID } from "node:crypto";
import { AsyncLocalStorage } from "node:async_hooks";

export type BackgroundWorkStatus = "queued" | "running" | "completed" | "failed";

export type BackgroundWorkReceipt = {
  id: string;
  queueId: string;
  label: string;
  enqueuedAt: string;
  startedAt: string | null;
  completedAt: string | null;
  status: BackgroundWorkStatus;
  error: string | null;
  metadata: Record<string, unknown>;
  done: Promise<BackgroundWorkReceipt>;
};

export type BackgroundWorkerQueue = {
  readonly queueId: string;
  enqueue: (
    job: {
      label: string;
      metadata?: Record<string, unknown>;
    },
    work: () => Promise<void>,
  ) => BackgroundWorkReceipt;
  drain: () => Promise<void>;
  receipts: () => BackgroundWorkReceipt[];
  pendingReceipts: () => BackgroundWorkReceipt[];
  yieldWhileWaiting: <T>(work: () => Promise<T>) => Promise<T>;
};

export type ServerWorkQueueId =
  | "turn-follow-up"
  | "checkpoint-diff"
  | "provider-runtime-ingestion"
  | "chat-workflow"
  | "local-agent-schedule"
  | "subagent"
  | "subagent-lifecycle";

export type ServerWorkQueues = {
  turnFollowUp: BackgroundWorkerQueue;
  checkpointDiff: BackgroundWorkerQueue;
  providerRuntimeIngestion: BackgroundWorkerQueue;
  chatWorkflow: BackgroundWorkerQueue;
  localAgentSchedule: BackgroundWorkerQueue;
  subagent: BackgroundWorkerQueue;
  subagentLifecycle: BackgroundWorkerQueue;
  drain: (queueId?: ServerWorkQueueId) => Promise<void>;
  receipts: (queueId?: ServerWorkQueueId) => BackgroundWorkReceipt[];
};

type QueueLogger = {
  warn: (message: string, fields?: Record<string, unknown>) => void;
};

const MAX_RETAINED_RECEIPTS = 200;

export function createBackgroundWorkerQueue(options: {
  queueId: string;
  logger?: QueueLogger;
  maxRetainedReceipts?: number;
  concurrency?: number;
  keyForJob?: (metadata: Record<string, unknown>) => string | null;
}): BackgroundWorkerQueue {
  const maxRetainedReceipts = options.maxRetainedReceipts ?? MAX_RETAINED_RECEIPTS;
  const pending = new Map<string, BackgroundWorkReceipt>();
  const retained: BackgroundWorkReceipt[] = [];
  const concurrency = Math.max(1, Math.trunc(options.concurrency ?? 1));
  const context = new AsyncLocalStorage<{ release(): void; reacquire(): Promise<void> }>();
  const ready: Array<{ key: string | null; resume: boolean; start(): void }> = [];
  const activeKeys = new Set<string>();
  let active = 0;
  function pump(): void {
    while (active < concurrency) {
      const index = ready.findIndex((job) => job.resume || !job.key || !activeKeys.has(job.key));
      if (index < 0) return;
      const job = ready.splice(index, 1)[0]!;
      active += 1;
      if (job.key) activeKeys.add(job.key);
      job.start();
    }
  }

  function enqueue(
    job: {
      label: string;
      metadata?: Record<string, unknown>;
    },
    work: () => Promise<void>,
  ): BackgroundWorkReceipt {
    const receipt: BackgroundWorkReceipt = {
      id: randomUUID(),
      queueId: options.queueId,
      label: job.label,
      enqueuedAt: new Date().toISOString(),
      startedAt: null,
      completedAt: null,
      status: "queued",
      error: null,
      metadata: job.metadata ?? {},
      done: Promise.resolve(null as unknown as BackgroundWorkReceipt),
    };

    const key = options.keyForJob?.(receipt.metadata) ?? null;
    let held = false;
    const release = () => { if (held) { held = false; active -= 1; pump(); } };
    const reacquire = () => new Promise<void>((resolve) => {
      ready.push({ key, resume: true, start: () => { held = true; resolve(); } });
      pump();
    });
    const run = async (): Promise<BackgroundWorkReceipt> => {
      receipt.status = "running";
      receipt.startedAt = new Date().toISOString();
      try {
        await context.run({ release, reacquire }, work);
        receipt.status = "completed";
      } catch (error) {
        receipt.status = "failed";
        receipt.error = textFromUnknown(error);
        options.logger?.warn("background queue job failed", {
          queueId: receipt.queueId,
          jobId: receipt.id,
          label: receipt.label,
          error: receipt.error,
        });
      } finally {
        receipt.completedAt = new Date().toISOString();
        pending.delete(receipt.id);
        retained.push(receipt);
        while (retained.length > maxRetainedReceipts) retained.shift();
        if (key) activeKeys.delete(key);
        release();
      }
      return receipt;
    };

    const done = new Promise<BackgroundWorkReceipt>((resolve) => {
      ready.push({ key, resume: false, start: () => { held = true; void run().then(resolve); } });
    });
    receipt.done = done;
    pending.set(receipt.id, receipt);
    queueMicrotask(pump);
    return receipt;
  }

  async function drain(): Promise<void> {
    while (pending.size > 0) {
      await Promise.all(Array.from(pending.values()).map((receipt) => receipt.done));
    }
  }

  return {
    queueId: options.queueId,
    enqueue,
    drain,
    receipts: () => [...retained, ...pending.values()],
    pendingReceipts: () => [...pending.values()],
    yieldWhileWaiting: async <T>(work: () => Promise<T>): Promise<T> => {
      const slot = context.getStore();
      if (!slot) return work();
      slot.release();
      try { return await work(); }
      finally { await slot.reacquire(); }
    },
  };
}

export function createServerWorkQueues(logger: QueueLogger): ServerWorkQueues {
  const taskQueueOptions = { concurrency: 8, keyForJob: (metadata: Record<string, unknown>) => {
    const key = metadata.sessionId ?? metadata.childSessionId ?? metadata.parentSessionId;
    return typeof key === "string" ? key : null;
  } };
  const turnFollowUp = createBackgroundWorkerQueue({ queueId: "turn-follow-up", logger, ...taskQueueOptions });
  const checkpointDiff = createBackgroundWorkerQueue({ queueId: "checkpoint-diff", logger });
  const providerRuntimeIngestion = createBackgroundWorkerQueue({
    queueId: "provider-runtime-ingestion",
    logger,
  });
  const localAgentSchedule = createBackgroundWorkerQueue({
    queueId: "local-agent-schedule",
    logger,
  });
  const chatWorkflow = createBackgroundWorkerQueue({
    queueId: "chat-workflow",
    logger,
  });
  const subagent = createBackgroundWorkerQueue({ queueId: "subagent", logger, ...taskQueueOptions,
    keyForJob: (metadata) => typeof metadata.runId === "string" ? metadata.runId : null });
  const subagentLifecycle = createBackgroundWorkerQueue({ queueId: "subagent-lifecycle", logger, ...taskQueueOptions });
  const byId: Record<ServerWorkQueueId, BackgroundWorkerQueue> = {
    "turn-follow-up": turnFollowUp,
    "checkpoint-diff": checkpointDiff,
    "provider-runtime-ingestion": providerRuntimeIngestion,
    "chat-workflow": chatWorkflow,
    "local-agent-schedule": localAgentSchedule,
    subagent,
    "subagent-lifecycle": subagentLifecycle,
  };

  return {
    turnFollowUp,
    checkpointDiff,
    providerRuntimeIngestion,
    chatWorkflow,
    localAgentSchedule,
    subagent,
    subagentLifecycle,
    drain: async (queueId?: ServerWorkQueueId) => {
      if (queueId) {
        await byId[queueId].drain();
        return;
      }
      const queues = Object.values(byId);
      while (queues.some((queue) => queue.pendingReceipts().length > 0)) {
        await Promise.all(queues.map((queue) => queue.drain()));
      }
    },
    receipts: (queueId?: ServerWorkQueueId) =>
      queueId
        ? byId[queueId].receipts()
        : Object.values(byId).flatMap((queue) => queue.receipts()),
  };
}

function textFromUnknown(value: unknown): string {
  if (typeof value === "string") return value;
  if (value instanceof Error) return value.message || value.name;
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}
