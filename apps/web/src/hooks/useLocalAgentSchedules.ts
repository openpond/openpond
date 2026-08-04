import { useEffect, useState } from "react";
import type { LocalAgentSchedule } from "@openpond/contracts";
import { api, type ClientConnection } from "../api";

const LOCAL_SCHEDULE_REFRESH_INTERVAL_MS = 5_000;

export function useLocalAgentSchedules(connection: ClientConnection | null) {
  const [schedules, setSchedules] = useState<LocalAgentSchedule[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pendingScheduleIds, setPendingScheduleIds] = useState<Set<string>>(
    () => new Set(),
  );

  useEffect(() => {
    if (!connection) {
      setSchedules([]);
      setError(null);
      setLoading(false);
      return;
    }

    const activeConnection = connection;
    let cancelled = false;
    async function load(showLoading: boolean) {
      if (cancelled) return;
      if (showLoading) setLoading(true);
      try {
        const payload = await api.localAgentSchedules(activeConnection);
        if (cancelled) return;
        setSchedules(payload.schedules);
        setError(null);
      } catch (caught) {
        if (!cancelled) setError(errorMessage(caught));
      } finally {
        if (!cancelled && showLoading) setLoading(false);
      }
    }

    void load(true);
    const intervalId = window.setInterval(
      () => void load(false),
      LOCAL_SCHEDULE_REFRESH_INTERVAL_MS,
    );
    return () => {
      cancelled = true;
      window.clearInterval(intervalId);
    };
  }, [connection]);

  async function refresh() {
    if (!connection) return;
    setLoading(true);
    try {
      const payload = await api.syncLocalAgentSchedules(connection);
      setSchedules(payload.schedules);
      setError(null);
    } catch (caught) {
      setError(errorMessage(caught));
    } finally {
      setLoading(false);
    }
  }

  async function run(schedule: LocalAgentSchedule) {
    if (!connection || pendingScheduleIds.has(schedule.id)) return;
    markPending(schedule.id, true);
    try {
      await api.runLocalAgentSchedule(connection, schedule.id);
      const payload = await api.localAgentSchedules(connection);
      setSchedules(payload.schedules);
      setError(null);
    } catch (caught) {
      setError(errorMessage(caught));
    } finally {
      markPending(schedule.id, false);
    }
  }

  async function toggle(schedule: LocalAgentSchedule) {
    if (!connection || pendingScheduleIds.has(schedule.id)) return;
    markPending(schedule.id, true);
    try {
      await api.patchLocalAgentSchedule(connection, schedule.id, {
        enabled: !schedule.enabled,
      });
      const payload = await api.localAgentSchedules(connection);
      setSchedules(payload.schedules);
      setError(null);
    } catch (caught) {
      setError(errorMessage(caught));
    } finally {
      markPending(schedule.id, false);
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
    error,
    loading,
    pendingScheduleIds,
    refresh,
    run,
    schedules,
    toggle,
  };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
