import { useCallback, useEffect, useState } from "react";
import type { TrainingRunDetail } from "@openpond/contracts";
import { api, type ClientConnection } from "../../api";

const ACTIVE_STATUSES = new Set(["queued", "starting", "running", "cancelling", "reconciling"]);

export function useTrainingRunDetail(connection: ClientConnection | null, jobId: string | null, jobStatus: string | null) {
  const [detail, setDetail] = useState<TrainingRunDetail | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    if (!connection || !jobId) return null;
    setLoading(true);
    try {
      const next = await api.trainingRunDetail(connection, jobId);
      setDetail(next);
      setError(null);
      return next;
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
      return null;
    } finally {
      setLoading(false);
    }
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
