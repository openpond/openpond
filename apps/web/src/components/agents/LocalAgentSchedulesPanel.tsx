import { useEffect, useState } from "react";
import { Pause, Play, RefreshCw, RotateCcw } from "lucide-react";
import type { LocalAgentSchedule } from "@openpond/contracts";
import { api, type ClientConnection } from "../../api";

const LOCAL_SCHEDULE_REFRESH_INTERVAL_MS = 5000;

export function LocalAgentSchedulesPanel({
  connection,
}: {
  connection: ClientConnection | null;
}) {
  const [localSchedules, setLocalSchedules] = useState<LocalAgentSchedule[]>([]);
  const [localSchedulesLoading, setLocalSchedulesLoading] = useState(false);
  const [localSchedulesError, setLocalSchedulesError] = useState<string | null>(null);
  const [pendingScheduleIds, setPendingScheduleIds] = useState<Set<string>>(() => new Set());

  useEffect(() => {
    if (!connection) {
      setLocalSchedules([]);
      setLocalSchedulesError(null);
      setLocalSchedulesLoading(false);
      return;
    }

    let cancelled = false;
    let intervalId: number | null = null;

    async function loadLocalSchedules(showLoading: boolean) {
      if (!connection || cancelled) return;
      if (showLoading) setLocalSchedulesLoading(true);
      try {
        const payload = await api.localAgentSchedules(connection);
        if (cancelled) return;
        setLocalSchedules(payload.schedules);
        setLocalSchedulesError(null);
      } catch (caught) {
        if (!cancelled) setLocalSchedulesError(errorMessage(caught));
      } finally {
        if (!cancelled && showLoading) setLocalSchedulesLoading(false);
      }
    }

    void loadLocalSchedules(true);
    intervalId = window.setInterval(() => void loadLocalSchedules(false), LOCAL_SCHEDULE_REFRESH_INTERVAL_MS);
    return () => {
      cancelled = true;
      if (intervalId !== null) window.clearInterval(intervalId);
    };
  }, [connection]);

  async function refreshLocalSchedules() {
    if (!connection) return;
    setLocalSchedulesLoading(true);
    try {
      const payload = await api.syncLocalAgentSchedules(connection);
      setLocalSchedules(payload.schedules);
      setLocalSchedulesError(null);
    } catch (caught) {
      setLocalSchedulesError(errorMessage(caught));
    } finally {
      setLocalSchedulesLoading(false);
    }
  }

  async function runLocalSchedule(schedule: LocalAgentSchedule) {
    if (!connection || pendingScheduleIds.has(schedule.id)) return;
    markSchedulePending(schedule.id, true);
    try {
      await api.runLocalAgentSchedule(connection, schedule.id);
      const payload = await api.localAgentSchedules(connection);
      setLocalSchedules(payload.schedules);
      setLocalSchedulesError(null);
    } catch (caught) {
      setLocalSchedulesError(errorMessage(caught));
    } finally {
      markSchedulePending(schedule.id, false);
    }
  }

  async function toggleLocalSchedule(schedule: LocalAgentSchedule) {
    if (!connection || pendingScheduleIds.has(schedule.id)) return;
    markSchedulePending(schedule.id, true);
    try {
      await api.patchLocalAgentSchedule(connection, schedule.id, { enabled: !schedule.enabled });
      const payload = await api.localAgentSchedules(connection);
      setLocalSchedules(payload.schedules);
      setLocalSchedulesError(null);
    } catch (caught) {
      setLocalSchedulesError(errorMessage(caught));
    } finally {
      markSchedulePending(schedule.id, false);
    }
  }

  function markSchedulePending(scheduleId: string, pending: boolean) {
    setPendingScheduleIds((current) => {
      const next = new Set(current);
      if (pending) next.add(scheduleId);
      else next.delete(scheduleId);
      return next;
    });
  }

  return (
    <section className="agent-schedule-section" aria-label="Local schedules">
      <div className="agent-section-header">
        <div>
          <span>Local schedules</span>
          <strong>{connection ? localSchedules.length : "Offline"}</strong>
        </div>
        <button
          type="button"
          className="agent-icon-button"
          title="Refresh local schedules"
          aria-label="Refresh local schedules"
          disabled={!connection || localSchedulesLoading}
          onClick={() => void refreshLocalSchedules()}
        >
          <RefreshCw size={16} aria-hidden="true" />
        </button>
      </div>
      {!connection ? (
        <div className="agent-create-empty">
          <p>Connect to the local OpenPond server before viewing schedules.</p>
        </div>
      ) : localSchedulesError ? (
        <div className="agent-create-error">{localSchedulesError}</div>
      ) : null}
      {connection && localSchedulesLoading && localSchedules.length === 0 ? (
        <div className="agent-create-loading compact" aria-label="Loading local schedules" role="status">
          <span />
        </div>
      ) : connection && localSchedules.length === 0 ? (
        <div className="agent-create-empty">
          <p>No local agent schedules detected.</p>
        </div>
      ) : connection ? (
        <div className="agent-card-grid schedule-grid" aria-busy={localSchedulesLoading}>
          {localSchedules.map((schedule) => (
            <LocalScheduleCard
              schedule={schedule}
              key={schedule.id}
              pending={pendingScheduleIds.has(schedule.id)}
              onRun={() => void runLocalSchedule(schedule)}
              onToggle={() => void toggleLocalSchedule(schedule)}
            />
          ))}
        </div>
      ) : null}
    </section>
  );
}

function LocalScheduleCard({
  schedule,
  pending,
  onRun,
  onToggle,
}: {
  schedule: LocalAgentSchedule;
  pending: boolean;
  onRun: () => void;
  onToggle: () => void;
}) {
  const status = schedule.enabled ? "enabled" : "paused";
  const toggleLabel = schedule.enabled ? "Pause schedule" : "Resume schedule";
  return (
    <article className="agent-card schedule-card">
      <div className="agent-card-topline">
        <span>{status}</span>
        <span>{schedule.scheduleType}</span>
      </div>
      <strong>{schedule.scheduleName}</strong>
      <p>{schedule.localProjectName}</p>
      <dl className="schedule-card-meta">
        <div>
          <dt>Expression</dt>
          <dd>{schedule.scheduleExpression}</dd>
        </div>
        <div>
          <dt>Next</dt>
          <dd>{formatScheduleDate(schedule.nextRunAt)}</dd>
        </div>
        <div>
          <dt>Last</dt>
          <dd>{schedule.lastRunStatus ?? "Not run"}</dd>
        </div>
        {schedule.timezone ? (
          <div>
            <dt>Timezone</dt>
            <dd>{schedule.timezone}</dd>
          </div>
        ) : null}
      </dl>
      {schedule.lastError ? <span className="schedule-card-error">{schedule.lastError}</span> : null}
      <div className="agent-card-actions">
        <button
          type="button"
          className="agent-icon-button"
          title="Run now"
          aria-label={`Run ${schedule.scheduleName} now`}
          disabled={pending}
          onClick={onRun}
        >
          <RotateCcw size={16} aria-hidden="true" />
        </button>
        <button
          type="button"
          className="agent-icon-button"
          title={toggleLabel}
          aria-label={`${toggleLabel}: ${schedule.scheduleName}`}
          disabled={pending}
          onClick={onToggle}
        >
          {schedule.enabled ? <Pause size={16} aria-hidden="true" /> : <Play size={16} aria-hidden="true" />}
        </button>
      </div>
    </article>
  );
}

function formatScheduleDate(value: string | null | undefined): string {
  if (!value) return "Not scheduled";
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return "Not scheduled";
  return date.toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
