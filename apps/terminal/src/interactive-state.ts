import type { RuntimeEvent } from "@openpond/contracts";

export type TerminalInteractivePhase = "starting" | "ready" | "running" | "switching" | "stopping";

export type TerminalInteractiveSnapshot = {
  phase: TerminalInteractivePhase;
  activeSessionId: string | null;
  activeTurnId: string | null;
};

export type TerminalStateTransition = { ok: true } | { ok: false; message: string };

const PENDING_TURN = "<submitting>";

export function createTerminalInteractiveState(initialSessionId: string | null = null) {
  const activeTurns = new Map<string, string>();
  let activeSessionId = initialSessionId;
  let ready = false;
  let switching = false;
  let stopping = false;

  function snapshot(): TerminalInteractiveSnapshot {
    const activeTurnId = activeSessionId ? activeTurns.get(activeSessionId) ?? null : null;
    const phase: TerminalInteractivePhase = stopping
      ? "stopping"
      : switching
        ? "switching"
        : !ready
          ? "starting"
          : activeTurnId
            ? "running"
            : "ready";
    return {
      phase,
      activeSessionId,
      activeTurnId: activeTurnId === PENDING_TURN ? null : activeTurnId,
    };
  }

  function blocked(action: string): TerminalStateTransition {
    const state = snapshot();
    if (state.phase === "ready") return { ok: true };
    const message = state.phase === "starting"
      ? `Wait for terminal startup and event recovery before ${action}.`
      : state.phase === "running"
        ? `A turn is already running. Interrupt or wait for it before ${action}.`
        : state.phase === "switching"
          ? `Wait for the session switch to finish before ${action}.`
          : `The terminal is stopping and cannot ${action}.`;
    return { ok: false, message };
  }

  function completeStartup(sessionId: string): void {
    if (stopping) return;
    activeSessionId = sessionId;
    ready = true;
  }

  function beginTurn(sessionId: string): TerminalStateTransition {
    const allowed = blocked("starting another turn");
    if (!allowed.ok) return allowed;
    if (sessionId !== activeSessionId) return { ok: false, message: "The active session changed; retry the turn." };
    activeTurns.set(sessionId, PENDING_TURN);
    return { ok: true };
  }

  function failTurnSubmission(sessionId: string): void {
    if (activeTurns.get(sessionId) === PENDING_TURN) activeTurns.delete(sessionId);
  }

  function applyRuntimeEvent(event: RuntimeEvent): void {
    const sessionId = event.sessionId ?? activeSessionId;
    if (!sessionId) return;
    if (event.name === "turn.started") {
      activeTurns.set(sessionId, event.turnId ?? PENDING_TURN);
      return;
    }
    if (event.name !== "turn.completed" && event.name !== "turn.failed" && event.name !== "turn.interrupted") return;
    const activeTurnId = activeTurns.get(sessionId);
    if (!activeTurnId) return;
    if (activeTurnId !== PENDING_TURN && event.turnId && event.turnId !== activeTurnId) return;
    activeTurns.delete(sessionId);
  }

  function beginSessionSwitch(): TerminalStateTransition {
    const allowed = blocked("switching sessions");
    if (!allowed.ok) return allowed;
    switching = true;
    return { ok: true };
  }

  function completeSessionSwitch(sessionId: string): void {
    activeSessionId = sessionId;
    switching = false;
  }

  function failSessionSwitch(): void {
    switching = false;
  }

  function beginStopping(): void {
    stopping = true;
  }

  return {
    applyRuntimeEvent,
    beginSessionSwitch,
    beginStopping,
    beginTurn,
    blocked,
    completeSessionSwitch,
    completeStartup,
    failSessionSwitch,
    failTurnSubmission,
    snapshot,
  };
}
