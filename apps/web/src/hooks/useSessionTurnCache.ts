import { useEffect, useState } from "react";
import type { UsageTurnCacheSummary } from "@openpond/contracts";
import { api, type ClientConnection } from "../api";

const EMPTY_TURN_CACHE = new Map<string, UsageTurnCacheSummary>();
const TURN_CACHE_RETRY_DELAYS_MS = [200, 600, 1_500] as const;

type TurnCacheState = {
  sessionId: string | null;
  summaries: ReadonlyMap<string, UsageTurnCacheSummary>;
};

export function useSessionTurnCache({
  connection,
  latestTurnId,
  sessionId,
  turnRunning,
}: {
  connection: ClientConnection | null;
  latestTurnId: string | null;
  sessionId: string | null;
  turnRunning: boolean;
}): ReadonlyMap<string, UsageTurnCacheSummary> {
  const [state, setState] = useState<TurnCacheState>(() => ({
    sessionId: null,
    summaries: EMPTY_TURN_CACHE,
  }));

  useEffect(() => {
    if (!connection || !sessionId) return undefined;

    let cancelled = false;
    let retryTimer: ReturnType<typeof setTimeout> | null = null;
    const expectedTurnId = turnRunning ? null : latestTurnId;

    const scheduleRetry = (attempt: number) => {
      const delay = TURN_CACHE_RETRY_DELAYS_MS[attempt];
      if (delay === undefined || cancelled) return;
      retryTimer = setTimeout(() => void load(attempt + 1), delay);
    };

    const load = async (attempt: number): Promise<void> => {
      try {
        const payload = await api.usageTurnCache(connection, sessionId);
        if (cancelled) return;
        const summaries = new Map(
          payload.turns.map((turn) => [turn.turnId, turn]),
        );
        setState({ sessionId, summaries });
        if (expectedTurnId && !summaries.has(expectedTurnId)) {
          scheduleRetry(attempt);
        }
      } catch {
        // Keep already-rendered metrics through transient server/HMR failures.
        scheduleRetry(attempt);
      }
    };

    void load(0);

    return () => {
      cancelled = true;
      if (retryTimer !== null) clearTimeout(retryTimer);
    };
  }, [connection, latestTurnId, sessionId, turnRunning]);

  return state.sessionId === sessionId ? state.summaries : EMPTY_TURN_CACHE;
}
