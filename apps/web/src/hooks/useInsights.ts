import { useCallback, useEffect, useState } from "react";
import type {
  InsightStatus,
  InsightRunTrigger,
  InsightsListResponse,
} from "@openpond/contracts";
import { api, type ClientConnection } from "../api";

const INSIGHTS_REFRESH_INTERVAL_MS = 60_000;

export function useInsights(input: {
  connection: ClientConnection | null;
}) {
  const { connection } = input;
  const [payload, setPayload] = useState<InsightsListResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [scanning, setScanning] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const serverUrl = connection?.serverUrl ?? null;
  const token = connection?.token ?? null;

  const refresh = useCallback(async () => {
    if (!connection) return null;
    setLoading(true);
    try {
      const next = await api.insights(connection, { status: "all", limit: 200 });
      setPayload(next);
      setError(null);
      return next;
    } catch (refreshError) {
      setError(refreshError instanceof Error ? refreshError.message : String(refreshError));
      return null;
    } finally {
      setLoading(false);
    }
  }, [connection]);

  const runScan = useCallback(async (input: { trigger?: InsightRunTrigger } = {}) => {
    if (!connection) return null;
    setScanning(true);
    try {
      const next = await api.runInsightsScan(connection, input);
      setPayload(next);
      setError(null);
      return next;
    } catch (scanError) {
      setError(scanError instanceof Error ? scanError.message : String(scanError));
      return null;
    } finally {
      setScanning(false);
    }
  }, [connection]);

  const patchStatus = useCallback(async (insightId: string, status: InsightStatus) => {
    if (!connection) return null;
    try {
      const next = await api.patchInsight(connection, insightId, { status });
      setPayload(next);
      setError(null);
      return next;
    } catch (patchError) {
      setError(patchError instanceof Error ? patchError.message : String(patchError));
      return null;
    }
  }, [connection]);

  const askQuestion = useCallback(async (question: string) => {
    if (!connection) return null;
    setScanning(true);
    try {
      const next = await api.askInsights(connection, { question });
      setPayload(next);
      setError(null);
      return next;
    } catch (askError) {
      setError(askError instanceof Error ? askError.message : String(askError));
      return null;
    } finally {
      setScanning(false);
    }
  }, [connection]);

  useEffect(() => {
    if (!connection) {
      setPayload(null);
      setError(null);
      return undefined;
    }
    let cancelled = false;
    const load = async () => {
      const next = await api.insights(connection, { status: "all", limit: 200 }).catch((loadError) => {
        setError(loadError instanceof Error ? loadError.message : String(loadError));
        return null;
      });
      if (!cancelled && next) {
        setPayload(next);
        setError(null);
      }
    };
    void load();
    const interval = window.setInterval(load, INSIGHTS_REFRESH_INTERVAL_MS);
    return () => {
      cancelled = true;
      window.clearInterval(interval);
    };
  }, [connection, serverUrl, token]);

  useEffect(() => {
    if (!connection || !payload?.nextScanAt) return undefined;
    const targetMs = new Date(payload.nextScanAt).getTime();
    if (Number.isNaN(targetMs)) return undefined;
    const delayMs = Math.max(1_000, Math.min(60_000, targetMs - Date.now() + 1_000));
    const timeout = window.setTimeout(() => {
      void refresh();
    }, delayMs);
    return () => window.clearTimeout(timeout);
  }, [connection, payload?.nextScanAt, refresh]);

  return {
    payload,
    items: payload?.items ?? [],
    runs: payload?.runs ?? [],
    systemSessionId: payload?.systemSessionId ?? null,
    systemSession: payload?.systemSession ?? null,
    summary: payload?.summary ?? null,
    nextScanAt: payload?.nextScanAt ?? null,
    scanRunning: Boolean(payload?.scanRunning) || scanning,
    scanStartedAt: payload?.scanStartedAt ?? null,
    loading,
    scanning,
    error,
    refresh,
    runScan,
    askQuestion,
    patchStatus,
  };
}
