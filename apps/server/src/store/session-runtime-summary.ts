import type { Session, Turn } from "@openpond/contracts";

type MutableSessionRuntimeSummary = {
  completedRuntimeMs: number;
  runningSinceMs: number | null;
};

export type SessionRuntimeSummary = {
  runtimeSeconds: number;
  runtimeRunningSince: string | null;
};

export function sessionRuntimeSummaries(
  turns: readonly Turn[]
): ReadonlyMap<string, SessionRuntimeSummary> {
  const mutableBySessionId = new Map<string, MutableSessionRuntimeSummary>();

  for (const turn of turns) {
    const startedAtMs = Date.parse(turn.startedAt);
    if (!Number.isFinite(startedAtMs)) continue;

    const summary = mutableBySessionId.get(turn.sessionId) ?? {
      completedRuntimeMs: 0,
      runningSinceMs: null,
    };
    const completedAtMs = turn.completedAt
      ? Date.parse(turn.completedAt)
      : Number.NaN;

    if (Number.isFinite(completedAtMs)) {
      summary.completedRuntimeMs += Math.max(0, completedAtMs - startedAtMs);
    } else if (
      turn.status === "in_progress" &&
      (summary.runningSinceMs === null || startedAtMs < summary.runningSinceMs)
    ) {
      summary.runningSinceMs = startedAtMs;
    }

    mutableBySessionId.set(turn.sessionId, summary);
  }

  return new Map(
    [...mutableBySessionId].map(([sessionId, summary]) => [
      sessionId,
      {
        runtimeSeconds: Math.max(
          0,
          Math.floor(summary.completedRuntimeMs / 1_000)
        ),
        runtimeRunningSince:
          summary.runningSinceMs === null
            ? null
            : new Date(summary.runningSinceMs).toISOString(),
      },
    ])
  );
}

export function sessionWithRuntimeSummary(
  session: Session,
  summary: SessionRuntimeSummary | undefined
): Session {
  return {
    ...session,
    runtimeSeconds: summary?.runtimeSeconds ?? 0,
    runtimeRunningSince: summary?.runtimeRunningSince ?? null,
  };
}
