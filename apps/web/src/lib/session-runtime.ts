import type { RuntimeEvent, Session } from "@openpond/contracts";

const TERMINAL_TURN_EVENTS = new Set<RuntimeEvent["name"]>([
  "turn.completed",
  "turn.failed",
  "turn.interrupted",
]);

export function sessionRuntimeSeconds(
  events: readonly RuntimeEvent[],
  observedAt: string | number = Date.now(),
  options: { includeRunning?: boolean } = {}
): number {
  const runtime = sessionEventRuntime(
    events,
    observedAt,
    options.includeRunning ?? true
  );
  return runtime.completedSeconds + runtime.runningSeconds;
}

export function sessionRuntimeFromStoredTurns(
  session: Session,
  events: readonly RuntimeEvent[],
  observedAt: string | number = Date.now(),
  options: { includeRunning?: boolean } = {}
): number | null {
  if (session.runtimeSeconds === undefined) return null;

  const includeRunning = options.includeRunning ?? true;
  const observedAtMs = parsedObservedAt(observedAt);
  const storedRunningSinceMs = session.runtimeRunningSince
    ? Date.parse(session.runtimeRunningSince)
    : Number.NaN;
  const storedRunningSeconds =
    includeRunning &&
    Number.isFinite(storedRunningSinceMs) &&
    observedAtMs > storedRunningSinceMs
      ? Math.floor((observedAtMs - storedRunningSinceMs) / 1_000)
      : 0;
  const eventRunningSeconds = sessionEventRuntime(
    events,
    observedAtMs,
    includeRunning
  ).runningSeconds;

  return (
    Math.max(0, Math.floor(session.runtimeSeconds)) +
    Math.max(storedRunningSeconds, eventRunningSeconds)
  );
}

function sessionEventRuntime(
  events: readonly RuntimeEvent[],
  observedAt: string | number,
  includeRunning: boolean
): { completedSeconds: number; runningSeconds: number } {
  const fallbackObservedAtMs = parsedObservedAt(observedAt);
  const startedAtByTurnId = new Map<string, number>();
  const lastActivityAtByTurnId = new Map<string, number>();
  const openTurnIds: string[] = [];
  let anonymousTurnSequence = 0;
  let completedRuntimeMs = 0;

  for (const event of events) {
    const eventAt = Date.parse(event.timestamp);
    if (!Number.isFinite(eventAt)) continue;

    if (event.name === "turn.started") {
      const turnId = event.turnId ?? `anonymous:${anonymousTurnSequence++}`;
      if (startedAtByTurnId.has(turnId)) continue;
      startedAtByTurnId.set(turnId, eventAt);
      lastActivityAtByTurnId.set(turnId, eventAt);
      openTurnIds.push(turnId);
      continue;
    }

    const explicitOpenTurnId =
      event.turnId && startedAtByTurnId.has(event.turnId)
        ? event.turnId
        : null;
    if (explicitOpenTurnId) {
      lastActivityAtByTurnId.set(
        explicitOpenTurnId,
        Math.max(
          lastActivityAtByTurnId.get(explicitOpenTurnId) ?? eventAt,
          eventAt
        )
      );
    }

    if (!TERMINAL_TURN_EVENTS.has(event.name)) continue;
    const turnId =
      explicitOpenTurnId ??
      latestOpenTurnId(openTurnIds, startedAtByTurnId);
    if (!turnId) continue;
    const startedAt = startedAtByTurnId.get(turnId);
    if (startedAt !== undefined && eventAt > startedAt) {
      completedRuntimeMs += eventAt - startedAt;
    }
    startedAtByTurnId.delete(turnId);
    lastActivityAtByTurnId.delete(turnId);
  }

  const liveTurnId = includeRunning
    ? latestOpenTurnId(openTurnIds, startedAtByTurnId)
    : null;
  let runningRuntimeMs = 0;
  for (const [turnId, startedAt] of startedAtByTurnId) {
    if (turnId === liveTurnId && fallbackObservedAtMs > startedAt) {
      runningRuntimeMs += fallbackObservedAtMs - startedAt;
      continue;
    }
    const lastActivityAt = lastActivityAtByTurnId.get(turnId) ?? startedAt;
    if (lastActivityAt > startedAt) {
      completedRuntimeMs += lastActivityAt - startedAt;
    }
  }

  return {
    completedSeconds: Math.max(0, Math.floor(completedRuntimeMs / 1_000)),
    runningSeconds: Math.max(0, Math.floor(runningRuntimeMs / 1_000)),
  };
}

export function formatSidebarRuntime(seconds: number): string {
  const safeSeconds = Math.max(0, Math.floor(seconds));
  if (safeSeconds < 60) return "<1m";
  const minutes = Math.floor(safeSeconds / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours >= 24) {
    const days = Math.floor(hours / 24);
    const remainingHours = hours % 24;
    return remainingHours > 0 ? `${days}d ${remainingHours}h` : `${days}d`;
  }
  const remainingMinutes = minutes % 60;
  return remainingMinutes > 0 ? `${hours}h ${remainingMinutes}m` : `${hours}h`;
}

function latestOpenTurnId(
  openTurnIds: readonly string[],
  startedAtByTurnId: ReadonlyMap<string, number>
): string | null {
  for (let index = openTurnIds.length - 1; index >= 0; index -= 1) {
    const turnId = openTurnIds[index];
    if (turnId && startedAtByTurnId.has(turnId)) return turnId;
  }
  return null;
}

function parsedObservedAt(observedAt: string | number): number {
  const observedAtMs =
    typeof observedAt === "number" ? observedAt : Date.parse(observedAt);
  return Number.isFinite(observedAtMs) ? observedAtMs : Date.now();
}
