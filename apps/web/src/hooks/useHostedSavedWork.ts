import { useEffect, useState } from "react";
import type {
  CreateHostedSavedWorkRequest,
  HostedSavedWorkDefinition,
  HostedSavedWorkRun,
  UpdateHostedSavedWorkRequest,
} from "@openpond/contracts";
import { api, type ClientConnection } from "../api";

const REFRESH_INTERVAL_MS = 30_000;

export function useHostedSavedWork(connection: ClientConnection | null) {
  const [definitions, setDefinitions] = useState<HostedSavedWorkDefinition[]>([]);
  const [runs, setRuns] = useState<HostedSavedWorkRun[]>([]);
  const [webBaseUrl, setWebBaseUrl] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pendingScheduleIds, setPendingScheduleIds] = useState<Set<string>>(
    () => new Set()
  );

  async function load(activeConnection: ClientConnection, showLoading: boolean) {
    if (showLoading) setLoading(true);
    try {
      const payload = await api.hostedSavedWork(activeConnection);
      setDefinitions(payload.definitions);
      setRuns(payload.runs);
      setWebBaseUrl(payload.webBaseUrl ?? null);
      setError(null);
    } catch (caught) {
      setError(errorMessage(caught));
    } finally {
      if (showLoading) setLoading(false);
    }
  }

  useEffect(() => {
    if (!connection) {
      setDefinitions([]);
      setRuns([]);
      setWebBaseUrl(null);
      setError(null);
      setLoading(false);
      return;
    }
    let cancelled = false;
    const refresh = async (showLoading: boolean) => {
      if (cancelled) return;
      if (showLoading) setLoading(true);
      try {
        const payload = await api.hostedSavedWork(connection);
        if (cancelled) return;
        setDefinitions(payload.definitions);
        setRuns(payload.runs);
        setWebBaseUrl(payload.webBaseUrl ?? null);
        setError(null);
      } catch (caught) {
        if (!cancelled) setError(errorMessage(caught));
      } finally {
        if (!cancelled && showLoading) setLoading(false);
      }
    };
    void refresh(true);
    const intervalId = window.setInterval(
      () => void refresh(false),
      REFRESH_INTERVAL_MS
    );
    return () => {
      cancelled = true;
      window.clearInterval(intervalId);
    };
  }, [connection]);

  async function refresh() {
    if (connection) await load(connection, true);
  }

  async function create(input: CreateHostedSavedWorkRequest) {
    if (!connection) return;
    await api.createHostedSavedWork(connection, input);
    await load(connection, false);
  }

  async function update(scheduleId: string, input: UpdateHostedSavedWorkRequest) {
    await mutate(scheduleId, async (activeConnection) => {
      await api.updateHostedSavedWork(activeConnection, scheduleId, input);
    });
  }

  async function remove(scheduleId: string) {
    await mutate(scheduleId, async (activeConnection) => {
      await api.deleteHostedSavedWork(activeConnection, scheduleId);
    });
  }

  async function run(scheduleId: string) {
    await mutate(scheduleId, async (activeConnection) => {
      await api.runHostedSavedWork(activeConnection, scheduleId, crypto.randomUUID());
    });
  }

  async function mutate(
    scheduleId: string,
    operation: (activeConnection: ClientConnection) => Promise<void>
  ) {
    if (!connection || pendingScheduleIds.has(scheduleId)) return;
    markPending(scheduleId, true);
    try {
      await operation(connection);
      await load(connection, false);
    } catch (caught) {
      setError(errorMessage(caught));
      throw caught;
    } finally {
      markPending(scheduleId, false);
    }
  }

  function markPending(scheduleId: string, pending: boolean) {
    setPendingScheduleIds((current) => {
      const next = new Set(current);
      if (pending) next.add(scheduleId);
      else next.delete(scheduleId);
      return next;
    });
  }

  return {
    create,
    definitions,
    error,
    loading,
    pendingScheduleIds,
    refresh,
    remove,
    run,
    runs,
    update,
    webBaseUrl,
  };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
