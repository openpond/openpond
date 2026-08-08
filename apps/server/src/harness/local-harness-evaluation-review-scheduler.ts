import type { HarnessEvaluationReviewReceipt } from "@openpond/contracts";

import type { SqliteStore } from "../store/store.js";
import type {
  HarnessEvaluationReviewCadence,
  HarnessEvaluationReviewSettings,
} from "../store/store-harness-workspaces.js";
import { DESKTOP_PERSONAL_HARNESS_OWNER_ID } from "./local-harness-selection.js";
import { reviewSelectedLocalHarnessEvaluationFromHost } from "./local-harness-evaluation-review-host.js";

const DEFAULT_TICK_MS = 15_000;

type SchedulerLogger = {
  info(message: string, metadata?: Record<string, unknown>): void;
  warn(message: string, metadata?: Record<string, unknown>): void;
};

export type LocalHarnessEvaluationReviewScheduler = {
  start(): void;
  stop(): Promise<void>;
  runDueNow(): Promise<HarnessEvaluationReviewReceipt | null>;
};

export function nextHarnessEvaluationReviewRunAt(
  cadence: HarnessEvaluationReviewCadence,
  from: string,
): string | null {
  if (cadence === "manual") return null;
  const next = new Date(from);
  next.setUTCDate(next.getUTCDate() + (cadence === "daily" ? 1 : 7));
  return next.toISOString();
}

export function createLocalHarnessEvaluationReviewScheduler(input: {
  store: SqliteStore;
  isClosing: () => boolean;
  logger?: SchedulerLogger;
  tickMs?: number;
  now?: () => string;
}): LocalHarnessEvaluationReviewScheduler {
  let interval: ReturnType<typeof setInterval> | null = null;
  let active: Promise<HarnessEvaluationReviewReceipt | null> | null = null;
  const now = input.now ?? (() => new Date().toISOString());

  async function runDueNow(): Promise<HarnessEvaluationReviewReceipt | null> {
    if (active) return active;
    active = (async () => {
      const workspace = await input.store.getSelectedHarnessWorkspace({
        ownerKind: "personal",
        ownerId: DESKTOP_PERSONAL_HARNESS_OWNER_ID,
      });
      if (!workspace) return null;
      const settings = await input.store.getHarnessEvaluationReviewSettings(workspace.id);
      const startedAt = now();
      if (
        !settings.enabled ||
        settings.cadence === "manual" ||
        !settings.nextRunAt ||
        settings.nextRunAt > startedAt
      ) return null;

      const claimed: HarnessEvaluationReviewSettings = {
        ...settings,
        nextRunAt: nextHarnessEvaluationReviewRunAt(settings.cadence, startedAt),
        lastRunAt: startedAt,
        lastError: null,
        updatedAt: startedAt,
      };
      await input.store.setHarnessEvaluationReviewSettings({
        workspaceId: workspace.id,
        settings: claimed,
      });
      try {
        const receipt = await reviewSelectedLocalHarnessEvaluationFromHost({
          store: input.store,
          workspaceId: workspace.id,
          maxEstimatedCostUsd: settings.maxEstimatedCostUsd,
          now,
        });
        await input.store.setHarnessEvaluationReviewSettings({
          workspaceId: workspace.id,
          settings: {
            ...claimed,
            lastResult: {
              id: receipt.id,
              contentHash: receipt.contentHash,
              classification: receipt.classification,
            },
            updatedAt: now(),
          },
        });
        input.logger?.info("Harness evaluation review schedule completed", {
          workspaceId: workspace.id,
          reviewId: receipt.id,
          classification: receipt.classification,
        });
        return receipt;
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        await input.store.setHarnessEvaluationReviewSettings({
          workspaceId: workspace.id,
          settings: { ...claimed, lastError: message, updatedAt: now() },
        });
        input.logger?.warn("Harness evaluation review schedule failed", {
          workspaceId: workspace.id,
          error: message,
        });
        return null;
      }
    })().finally(() => {
      active = null;
    });
    return active;
  }

  return {
    start() {
      if (interval) return;
      interval = setInterval(() => {
        if (!input.isClosing()) void runDueNow();
      }, input.tickMs ?? DEFAULT_TICK_MS);
      interval.unref?.();
      void runDueNow();
    },
    async stop() {
      if (interval) clearInterval(interval);
      interval = null;
      await active;
    },
    runDueNow,
  };
}
