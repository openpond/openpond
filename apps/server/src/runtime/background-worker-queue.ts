import { randomUUID } from "node:crypto";

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
};

export type ServerWorkQueueId =
  | "turn-follow-up"
  | "checkpoint-diff"
  | "provider-runtime-ingestion"
  | "insights"
  | "local-agent-schedule"
  | "subagent"
  | "subagent-lifecycle";

export type ServerWorkQueues = {
  turnFollowUp: BackgroundWorkerQueue;
  checkpointDiff: BackgroundWorkerQueue;
  providerRuntimeIngestion: BackgroundWorkerQueue;
  insights: BackgroundWorkerQueue;
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
}): BackgroundWorkerQueue {
  const maxRetainedReceipts = options.maxRetainedReceipts ?? MAX_RETAINED_RECEIPTS;
  const pending = new Map<string, BackgroundWorkReceipt>();
  const retained: BackgroundWorkReceipt[] = [];
  let tail = Promise.resolve();

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

    const run = async (): Promise<BackgroundWorkReceipt> => {
      receipt.status = "running";
      receipt.startedAt = new Date().toISOString();
      try {
        await work();
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
      }
      return receipt;
    };

    const done = tail.then(run, run);
    receipt.done = done;
    pending.set(receipt.id, receipt);
    tail = done.then(
      () => undefined,
      () => undefined,
    );
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
  };
}

export function createServerWorkQueues(logger: QueueLogger): ServerWorkQueues {
  const turnFollowUp = createBackgroundWorkerQueue({ queueId: "turn-follow-up", logger });
  const checkpointDiff = createBackgroundWorkerQueue({ queueId: "checkpoint-diff", logger });
  const providerRuntimeIngestion = createBackgroundWorkerQueue({
    queueId: "provider-runtime-ingestion",
    logger,
  });
  const insights = createBackgroundWorkerQueue({ queueId: "insights", logger });
  const localAgentSchedule = createBackgroundWorkerQueue({
    queueId: "local-agent-schedule",
    logger,
  });
  const subagent = createBackgroundWorkerQueue({ queueId: "subagent", logger });
  const subagentLifecycle = createBackgroundWorkerQueue({ queueId: "subagent-lifecycle", logger });
  const byId: Record<ServerWorkQueueId, BackgroundWorkerQueue> = {
    "turn-follow-up": turnFollowUp,
    "checkpoint-diff": checkpointDiff,
    "provider-runtime-ingestion": providerRuntimeIngestion,
    insights,
    "local-agent-schedule": localAgentSchedule,
    subagent,
    "subagent-lifecycle": subagentLifecycle,
  };

  return {
    turnFollowUp,
    checkpointDiff,
    providerRuntimeIngestion,
    insights,
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
