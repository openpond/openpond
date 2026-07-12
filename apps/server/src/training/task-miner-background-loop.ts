import type { loadOpenPondProfileState } from "@openpond/cloud";
import type { TaskCandidate } from "@openpond/contracts";
import type { createTaskMinerService } from "./task-miner.js";

export function createTaskMinerBackgroundLoop(input: {
  service: ReturnType<typeof createTaskMinerService>;
  loadProfileState: typeof loadOpenPondProfileState;
  isClosing: () => boolean;
  intervalMs?: number;
  logger?: { warn(message: string, metadata?: Record<string, unknown>): void };
}) {
  const intervalMs = input.intervalMs ?? 30 * 60 * 1_000;
  let interval: ReturnType<typeof setInterval> | null = null;
  let running = false;
  let lastRunAt: string | null = null;
  let lastError: string | null = null;

  async function tickNow(): Promise<{ skippedReason: string | null; candidates: TaskCandidate[] }> {
    if (input.isClosing()) return { skippedReason: "server_closing", candidates: [] };
    if (running) return { skippedReason: "scan_running", candidates: [] };
    running = true;
    try {
      const profile = await input.loadProfileState();
      const profileId = profile.activeProfile ?? "default";
      const config = await input.service.config(profileId);
      if (!config.enabled) return { skippedReason: "miner_disabled", candidates: [] };
      const candidates = await input.service.run({ profileId, config });
      lastRunAt = new Date().toISOString();
      lastError = null;
      return { skippedReason: null, candidates };
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
      input.logger?.warn("task miner background scan failed", { error: lastError });
      throw error;
    } finally {
      running = false;
    }
  }

  return {
    start() {
      if (interval || input.isClosing()) return;
      interval = setInterval(() => void tickNow().catch(() => undefined), intervalMs);
      interval.unref?.();
    },
    stop() { if (interval) clearInterval(interval); interval = null; },
    tickNow,
    status: () => ({ running, lastRunAt, lastError }),
  };
}
