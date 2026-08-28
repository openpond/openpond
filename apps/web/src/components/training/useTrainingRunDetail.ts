import { useCallback, useEffect, useRef, useState } from "react";
import type { TrainingRunDetail } from "@openpond/contracts";
import { api, type ClientConnection } from "../../api";

const ACTIVE_STATUSES = new Set(["queued", "starting", "running", "cancelling", "reconciling"]);

export function useTrainingRunDetail(connection: ClientConnection | null, jobId: string | null, jobStatus: string | null) {
  const [detail, setDetail] = useState<TrainingRunDetail | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const activeJobId = useRef(jobId);
  const refreshInFlight = useRef<{
    jobId: string;
    request: Promise<TrainingRunDetail | null>;
  } | null>(null);
  activeJobId.current = jobId;

  const refresh = useCallback((): Promise<TrainingRunDetail | null> => {
    if (!connection || !jobId) return Promise.resolve(null);
    if (refreshInFlight.current?.jobId === jobId) {
      return refreshInFlight.current.request;
    }
    setLoading(true);
    const request = api.trainingRunDetail(connection, jobId)
      .then((next) => {
        if (activeJobId.current === jobId) {
          setDetail(next);
          setError(null);
        }
        return next;
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
    refreshInFlight.current = { jobId, request };
    return request;
  }, [connection, jobId]);

  useEffect(() => {
    setDetail(null);
    setError(null);
    if (!connection || !jobId) return;
    void refresh();
  }, [connection, jobId, refresh]);

  useEffect(() => {
    if (!connection || !jobId || !jobStatus || !ACTIVE_STATUSES.has(jobStatus)) return undefined;
    const interval = window.setInterval(() => void refresh(), 2_000);
    return () => window.clearInterval(interval);
  }, [connection, jobId, jobStatus, refresh]);

  return { detail, error, loading, refresh };
}
