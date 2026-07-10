import type { Turn } from "@openpond/contracts";
import type { BackgroundWorkerQueue } from "../background-worker-queue.js";
import type { ActiveTurnRegistry } from "./active-turn-registry.js";
import type { KeyedRegistry } from "./keyed-registry.js";
import type { ActiveTurn } from "./ports.js";

type LifecycleJob = { done: Promise<unknown> };

export function createActiveTurnSettlement(): Pick<ActiveTurn, "settled" | "settle"> {
  let settle!: () => void;
  const settled = new Promise<void>((resolve) => {
    settle = resolve;
  });
  return { settled, settle };
}

export function createTurnRunnerLifecycle(deps: {
  activeTurns: ActiveTurnRegistry;
  interruptActiveTurn(active: ActiveTurn, reason: string): Promise<Turn>;
  jobRegistries: readonly KeyedRegistry<LifecycleJob>[];
  queues: readonly BackgroundWorkerQueue[];
}) {
  const pendingSendTurns = new Set<Promise<void>>();
  let closing = false;
  let closePromise: Promise<void> | null = null;
  let interruptAllPromise: Promise<Turn[]> | null = null;

  function beginSendTurn(): () => void {
    if (closing) throw new Error("Turn runner is closed.");
    let resolve!: () => void;
    const settled = new Promise<void>((done) => {
      resolve = done;
    });
    pendingSendTurns.add(settled);
    return () => {
      pendingSendTurns.delete(settled);
      resolve();
    };
  }

  function registerActiveTurn(sessionId: string, active: ActiveTurn): void {
    deps.activeTurns.set(sessionId, active);
    if (closing) active.controller.abort();
  }

  function interruptAll(reason = "Server shutting down"): Promise<Turn[]> {
    if (interruptAllPromise) return interruptAllPromise;
    const operation = (async () => {
      const active = [...deps.activeTurns.values()];
      const results = await Promise.allSettled(
        active.map((turn) => deps.interruptActiveTurn(turn, reason)),
      );
      await Promise.all(active.map((turn) => turn.settled));
      const failures = results.flatMap((result) => result.status === "rejected" ? [result.reason] : []);
      if (failures.length > 0) throw new AggregateError(failures, "Failed to interrupt every active turn.");
      return results.flatMap((result) => result.status === "fulfilled" ? [result.value] : []);
    })();
    interruptAllPromise = operation;
    void operation.finally(() => {
      if (interruptAllPromise === operation) interruptAllPromise = null;
    }).catch(() => undefined);
    return operation;
  }

  async function drainQueues(): Promise<void> {
    const queues = [...new Set(deps.queues)];
    while (queues.some((queue) => queue.pendingReceipts().length > 0)) {
      await Promise.all(queues.map((queue) => queue.drain()));
    }
  }

  function assertIdle(): void {
    deps.activeTurns.assertEmpty();
    for (const registry of deps.jobRegistries) registry.assertEmpty();
    if (pendingSendTurns.size > 0) throw new Error(`Turn runner leaked ${pendingSendTurns.size} send operation(s).`);
    const pendingJobs = deps.queues.flatMap((queue) => queue.pendingReceipts());
    if (pendingJobs.length > 0) throw new Error(`Turn runner leaked ${pendingJobs.length} queued job(s).`);
  }

  function close(): Promise<void> {
    if (closePromise) return closePromise;
    closing = true;
    closePromise = (async () => {
      let interruptFailure: unknown = null;
      await interruptAll().catch((error) => {
        interruptFailure = error;
      });
      await Promise.all([...pendingSendTurns]);
      await drainQueues();
      assertIdle();
      if (interruptFailure) throw interruptFailure;
    })();
    return closePromise;
  }

  return { beginSendTurn, close, interruptAll, registerActiveTurn };
}
