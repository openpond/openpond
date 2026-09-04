import { useCallback, useEffect, useRef, useState } from "react";
import type { TrainingRunDetail } from "@openpond/contracts";
import { api, type ClientConnection } from "../../api";

const ACTIVE_STATUSES = new Set([
  "queued",
  "starting",
  "running",
  "cancelling",
  "reconciling",
]);

type CachedRunDetail = {
  detail: TrainingRunDetail;
  includesEvaluation: boolean;
};

const runDetailCache = new WeakMap<
  ClientConnection,
  Map<string, CachedRunDetail>
>();

export function useTrainingRunDetail(
  connection: ClientConnection | null,
  jobId: string | null,
  jobStatus: string | null,
  includeEvaluation = false,
) {
  const [detail, setDetail] = useState<TrainingRunDetail | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const activeJobId = useRef(jobId);
  const refreshInFlight = useRef<{
    key: string;
    request: Promise<TrainingRunDetail | null>;
  } | null>(null);
  activeJobId.current = jobId;

  const refresh = useCallback(
    (withEvaluation = includeEvaluation): Promise<TrainingRunDetail | null> => {
      if (!connection || !jobId) return Promise.resolve(null);
      const key = `${jobId}:${withEvaluation ? "full" : "live"}`;
      if (refreshInFlight.current?.key === key) {
        return refreshInFlight.current.request;
      }
      setLoading(true);
      const request = api
        .trainingRunDetail(connection, jobId, {
          includeEvaluation: withEvaluation,
        })
        .then((next) => {
          const cache = connectionCache(connection);
          const previous = cache.get(jobId);
          const merged =
            !withEvaluation && previous?.includesEvaluation
              ? { ...next, evaluation: previous.detail.evaluation }
              : next;
          cache.set(jobId, {
            detail: merged,
            includesEvaluation:
              withEvaluation || previous?.includesEvaluation === true,
          });
          if (activeJobId.current === jobId) {
            setDetail(merged);
            setError(null);
          }
          return merged;
        })
        .catch((caught: unknown) => {
          if (activeJobId.current === jobId) {
            setError(caught instanceof Error ? caught.message : String(caught));
          }
          return null;
        })
        .finally(() => {
          if (refreshInFlight.current?.request === request) {
            refreshInFlight.current = null;
            setLoading(false);
          }
        });
      refreshInFlight.current = { key, request };
      return request;
    },
    [connection, includeEvaluation, jobId],
  );

  useEffect(() => {
    setError(null);
    if (!connection || !jobId) {
      setDetail(null);
      return;
    }
    const cached = connectionCache(connection).get(jobId);
    setDetail(cached?.detail ?? null);
    void refresh(includeEvaluation);
  }, [connection, includeEvaluation, jobId, refresh]);

  useEffect(() => {
    if (
      !connection ||
      !jobId ||
      !jobStatus ||
      !ACTIVE_STATUSES.has(jobStatus)
    ) {
      return undefined;
    }
    const interval = window.setInterval(() => void refresh(false), 2_000);
    return () => window.clearInterval(interval);
  }, [connection, jobId, jobStatus, refresh]);

  return { detail, error, loading, refresh };
}

function connectionCache(
  connection: ClientConnection,
): Map<string, CachedRunDetail> {
  const existing = runDetailCache.get(connection);
  if (existing) return existing;
  const created = new Map<string, CachedRunDetail>();
  runDetailCache.set(connection, created);
  return created;
}
