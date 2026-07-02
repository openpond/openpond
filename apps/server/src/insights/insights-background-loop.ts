import type { InsightRunTrigger, InsightsScanResponse } from "@openpond/contracts";
import type { BackgroundWorkerQueue } from "../runtime/background-worker-queue.js";
import type { InsightsService } from "./create-edit-insights.js";

type InsightsLoopLogger = {
  warn(message: string, metadata?: Record<string, unknown>): void;
};

export type InsightsBackgroundLoop = {
  start: () => void;
  stop: () => void;
  scanNow: (options?: { force?: boolean; trigger?: InsightRunTrigger }) => Promise<InsightsScanResponse>;
  nextScanAt: () => string | null;
  status: () => InsightsBackgroundStatus;
};

export type InsightsBackgroundStatus = {
  nextScanAt: string | null;
  scanRunning: boolean;
  scanStartedAt: string | null;
};

const DEFAULT_INSIGHTS_SCAN_INTERVAL_MS = 5 * 60 * 1000;

export function createInsightsBackgroundLoop(options: {
  service: InsightsService;
  queue: BackgroundWorkerQueue;
  isClosing: () => boolean;
  logger?: InsightsLoopLogger;
  intervalMs?: number;
}): InsightsBackgroundLoop {
  const intervalMs = options.intervalMs ?? DEFAULT_INSIGHTS_SCAN_INTERVAL_MS;
  let interval: ReturnType<typeof setInterval> | null = null;
  let nextIntervalScanAtMs: number | null = null;

  function scheduledScanAt(): string | null {
    return nextIntervalScanAtMs === null ? null : new Date(nextIntervalScanAtMs).toISOString();
  }

  function currentScanReceipt() {
    return options.queue
      .pendingReceipts()
      .find((receipt) => receipt.label === "insights-scan" && receipt.status === "running") ?? null;
  }

  function enqueueScan(reason: InsightRunTrigger, force = false): Promise<InsightsScanResponse> {
    let result: InsightsScanResponse | null = null;
    const receipt = options.queue.enqueue(
      {
        label: "insights-scan",
        metadata: { reason, force },
      },
      async () => {
        result = await options.service.scan({ force, trigger: reason });
      },
    );
    return receipt.done.then(() => {
      if (receipt.status === "failed") throw new Error(receipt.error ?? "Insights scan failed");
      if (!result) throw new Error("Insights scan did not return a result");
      return result;
    });
  }

  function scheduleScan(reason: Extract<InsightRunTrigger, "interval">): void {
    if (options.isClosing()) return;
    void enqueueScan(reason).catch((error) => {
      if (options.isClosing()) return;
      options.logger?.warn("insights background scan failed", {
        reason,
        error: error instanceof Error ? error.message : String(error),
      });
    });
  }

  return {
    start() {
      if (interval || options.isClosing()) return;
      const startedAt = Date.now();
      nextIntervalScanAtMs = startedAt + intervalMs;
      interval = setInterval(() => {
        nextIntervalScanAtMs = Date.now() + intervalMs;
        scheduleScan("interval");
      }, intervalMs);
      interval.unref?.();
    },
    stop() {
      if (interval) {
        clearInterval(interval);
        interval = null;
      }
      nextIntervalScanAtMs = null;
    },
    scanNow(options = {}) {
      return enqueueScan(options.trigger ?? "manual", options.force ?? true);
    },
    nextScanAt() {
      return scheduledScanAt();
    },
    status() {
      const runningScan = currentScanReceipt();
      return {
        nextScanAt: scheduledScanAt(),
        scanRunning: Boolean(runningScan),
        scanStartedAt: runningScan?.startedAt ?? null,
      };
    },
  };
}
