import type { AccountState, HostedWorkSchedulesResponse } from "@openpond/contracts";
import { useEffect, useMemo, useState } from "react";
import { api, type ClientConnection } from "../../api";
import "../../styles/scheduled/hosted-scheduled-work.css";
import { Loader2, Pause, Play, RefreshCw, Trash2 } from "../icons";

type Props = {
  account: AccountState | null;
  connection: ClientConnection | null;
  teamId: string | null;
  onToast?: (message: string, tone?: "success" | "error" | "info") => void;
};

type ScheduleRow = {
  definition: HostedWorkSchedulesResponse["definitions"][number];
  schedule: HostedWorkSchedulesResponse["definitions"][number]["schedules"][number];
};

export function HostedScheduledWorkView({ account, connection, teamId, onToast }: Props) {
  const [payload, setPayload] = useState<HostedWorkSchedulesResponse | null>(null);
  const [state, setState] = useState<"idle" | "loading" | "ready" | "error">("idle");
  const [error, setError] = useState<string | null>(null);
  const [filter, setFilter] = useState<"active" | "paused" | "all">("active");
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [pending, setPending] = useState<string | null>(null);

  async function load(active = () => true) {
    if (!connection || !teamId) {
      setPayload(null);
      setState("idle");
      return;
    }
    setState("loading");
    setError(null);
    try {
      const result = await api.hostedWorkSchedules(connection, teamId);
      if (!active()) return;
      setPayload(result);
      setState("ready");
    } catch (caught) {
      if (!active()) return;
      setError(errorMessage(caught));
      setState("error");
    }
  }

  useEffect(() => {
    let active = true;
    setSelectedId(null);
    void load(() => active);
    return () => {
      active = false;
    };
  }, [connection, teamId]);

  const rows = useMemo(
    () =>
      (payload?.definitions ?? [])
        .flatMap((definition) =>
          definition.schedules.map((schedule) => ({ definition, schedule })),
        )
        .filter((row) =>
          filter === "all" ? true : filter === "active" ? row.schedule.enabled : !row.schedule.enabled,
        )
        .toSorted((a, b) =>
          (a.schedule.nextRunAt ?? "9999").localeCompare(b.schedule.nextRunAt ?? "9999"),
        ),
    [filter, payload],
  );
  const selected = rows.find((row) => row.schedule.id === selectedId) ?? rows[0] ?? null;
  const runs = selected
    ? (payload?.runs ?? []).filter((run) => run.scheduleId === selected.schedule.id)
    : [];

  async function mutate(key: string, action: () => Promise<unknown>, message: string) {
    if (!connection || !teamId) return;
    setPending(key);
    try {
      await action();
      await load();
      onToast?.(message, "success");
    } catch (caught) {
      onToast?.(errorMessage(caught), "error");
    } finally {
      setPending(null);
    }
  }

  const webBase = account?.baseUrl ?? account?.activeProfile?.baseUrl ?? "https://openpond.ai";
  return (
    <section className="hosted-scheduled-view" aria-label="Scheduled">
      <header className="hosted-scheduled-header">
        <div>
          <h1>Scheduled</h1>
          <p>Run Work tasks automatically, even when OpenPond is closed.</p>
          {teamId ? <small>Team: {teamId}</small> : null}
        </div>
        <div className="hosted-scheduled-header-actions">
          <button type="button" className="secondary" onClick={() => void load()} disabled={state === "loading"}>
            <RefreshCw size={15} /> Refresh
          </button>
          <button type="button" onClick={() => window.open(`${webBase.replace(/\/$/, "")}/sandboxes`, "_blank", "noopener,noreferrer")}>
            New scheduled task
          </button>
        </div>
      </header>
      {!teamId ? <div className="hosted-scheduled-empty">Select a default Team in Account settings to view Scheduled Work.</div> : null}
      {teamId ? (
        <div className="hosted-scheduled-body">
          <aside className="hosted-scheduled-list">
            <div className="hosted-scheduled-filters" role="group" aria-label="Schedule status">
              {(["active", "paused", "all"] as const).map((value) => (
                <button key={value} type="button" className={filter === value ? "active" : ""} onClick={() => setFilter(value)}>{value}</button>
              ))}
            </div>
            {state === "loading" && !payload ? <div className="hosted-scheduled-loading"><Loader2 size={16} /> Loading schedules</div> : null}
            {state === "error" ? <div className="hosted-scheduled-error">{error}</div> : null}
            {state === "ready" && rows.length === 0 ? <div className="hosted-scheduled-empty">Create a scheduled task in OpenPond Web, then it will appear here.</div> : null}
            {rows.map((row) => (
              <button key={row.schedule.id} type="button" className={`hosted-scheduled-row ${selected?.schedule.id === row.schedule.id ? "active" : ""}`} onClick={() => setSelectedId(row.schedule.id)}>
                <span><i className={row.schedule.enabled ? "enabled" : ""} />{row.definition.name}</span>
                <small>{cadence(row)} · {row.schedule.timeZone}</small>
                <small>{row.schedule.nextRunAt ? `Next ${new Date(row.schedule.nextRunAt).toLocaleString()}` : "No next run"}</small>
              </button>
            ))}
          </aside>
          <main className="hosted-scheduled-detail">
            {selected ? (
              <>
                <div className="hosted-scheduled-detail-heading">
                  <div><h2>{selected.definition.name}</h2><p>{cadence(selected)} · {selected.schedule.enabled ? "Active" : "Paused"}</p></div>
                  <div>
                    <button type="button" disabled={pending !== null} onClick={() => void mutate(`run:${selected.schedule.id}`, () => api.runHostedWorkSchedule(connection!, { teamId, scheduleId: selected.schedule.id, clientRequestId: crypto.randomUUID() }), "Run queued")}><Play size={14} /> Run now</button>
                    <button type="button" className="secondary" disabled={pending !== null} onClick={() => void mutate(`toggle:${selected.schedule.id}`, () => api.toggleHostedWorkSchedule(connection!, { teamId, scheduleId: selected.schedule.id, enabled: !selected.schedule.enabled }), selected.schedule.enabled ? "Schedule paused" : "Schedule resumed")}><Pause size={14} /> {selected.schedule.enabled ? "Pause" : "Resume"}</button>
                    <button type="button" className="icon" aria-label="Delete schedule" disabled={pending !== null} onClick={() => { if (window.confirm("Delete this scheduled task?")) void mutate(`delete:${selected.schedule.id}`, () => api.deleteHostedWorkSchedule(connection!, { teamId, scheduleId: selected.schedule.id }), "Schedule deleted"); }}><Trash2 size={15} /></button>
                  </div>
                </div>
                <section><h3>Prompt</h3><p className="prompt">{selected.definition.prompt}</p></section>
                <section><h3>Schedule</h3><dl><div><dt>Cadence</dt><dd>{cadence(selected)}</dd></div><div><dt>Timezone</dt><dd>{selected.schedule.timeZone}</dd></div><div><dt>Next run</dt><dd>{selected.schedule.nextRunAt ? new Date(selected.schedule.nextRunAt).toLocaleString() : "None"}</dd></div><div><dt>Model</dt><dd>{selected.definition.modelId}</dd></div></dl></section>
                <section><h3>Run history</h3>{runs.length === 0 ? <p className="muted">No runs for this schedule yet.</p> : runs.map((run) => <div className="hosted-scheduled-run" key={run.id}><span>{run.status}</span><span>{new Date(run.createdAt).toLocaleString()}</span><span>Delivery: {run.deliveryStatus}</span></div>)}</section>
              </>
            ) : <div className="hosted-scheduled-empty">Select a schedule to review its details.</div>}
          </main>
        </div>
      ) : null}
    </section>
  );
}

function cadence(row: ScheduleRow): string {
  const recurrence = row.schedule.recurrence;
  const frequency = typeof recurrence.frequency === "string" ? recurrence.frequency : null;
  const localTime = typeof recurrence.localTime === "string" ? recurrence.localTime : null;
  if (frequency && localTime) return `${frequency[0]!.toUpperCase()}${frequency.slice(1)} at ${localTime}`;
  return row.schedule.expression ?? "Scheduled";
}

function errorMessage(value: unknown): string {
  return value instanceof Error ? value.message : "Unable to load Scheduled Work.";
}
