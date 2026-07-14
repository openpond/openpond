import type { Turn } from "@openpond/contracts";
import type { ActiveTurnRegistry } from "./active-turn-registry.js";
import type { ActiveTurn, TurnRunnerDependencies } from "./ports.js";

export function createInterruptionRuntime(deps: {
  activeTurns: ActiveTurnRegistry;
  getSession: TurnRunnerDependencies["getSession"];
  getTurn(turnId: string): Promise<Turn | null>;
  latestTurnForSession(sessionId: string, status?: Turn["status"]): Promise<Turn | null>;
  interruptTurn: TurnRunnerDependencies["interruptTurn"];
}) {
  function interruptedError(): Error {
    const error = new Error("Stopped by user");
    error.name = "AbortError";
    return error;
  }

  function throwIfInterrupted(signal: AbortSignal): void {
    if (signal.aborted) throw interruptedError();
  }

  function waitForInterrupt(signal: AbortSignal): Promise<never> {
    if (signal.aborted) return Promise.reject(interruptedError());
    return new Promise((_, reject) => {
      signal.addEventListener("abort", () => reject(interruptedError()), { once: true });
    });
  }

  async function interruptActiveTurn(active: ActiveTurn, reason: string): Promise<Turn> {
    active.interruptionReason ??= reason;
    active.controller.abort();
    if (active.codexRuntime && active.codexTurnId) {
      try {
        await active.codexRuntime.client.interruptTurn({
          threadId: active.codexRuntime.threadId,
          turnId: active.codexTurnId,
        });
      } catch {
        await active.codexRuntime.client.stop().catch(() => undefined);
      }
    }
    return deps.interruptTurn(active.session, active.turn.id, reason);
  }

  async function findInProgressTurn(sessionId: string): Promise<Turn | null> {
    return deps.latestTurnForSession(sessionId, "in_progress");
  }

  async function interruptSessionTurn(sessionId: string, reason = "Stopped by user"): Promise<Turn> {
    const active = deps.activeTurns.get(sessionId);
    const session = active?.session ?? await deps.getSession(sessionId);
    const inProgressTurn = active?.turn ?? await findInProgressTurn(sessionId);
    if (!inProgressTurn) throw new Error("No active turn to stop.");
    return active
      ? interruptActiveTurn(active, reason)
      : deps.interruptTurn(session, inProgressTurn.id, reason);
  }

  async function turnWasInterrupted(turnId: string): Promise<boolean> {
    return (await deps.getTurn(turnId))?.status === "interrupted";
  }

  async function activeInProgressTurn(sessionId: string): Promise<Turn | null> {
    const active = deps.activeTurns.get(sessionId);
    if (!active) return null;
    const stored = await deps.getTurn(active.turn.id);
    return !stored || stored.status === "in_progress" ? active.turn : null;
  }

  return {
    activeInProgressTurn,
    findInProgressTurn,
    interruptActiveTurn,
    interruptedError,
    interruptSessionTurn,
    throwIfInterrupted,
    turnWasInterrupted,
    waitForInterrupt,
  };
}
