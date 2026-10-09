import { useState } from "react";
import {
  diagnosticAnalysisPrompt,
  diagnosticSpans,
  type RunDiagnostics,
} from "openpond-sdk/experiments";

const money = (value: number | null) => (value === null ? "—" : `$${value.toFixed(6)}`);
const duration = (value: number | null) =>
  value === null
    ? "—"
    : value < 1000
      ? `${value} ms`
      : value < 60000
        ? `${(value / 1000).toFixed(1)} s`
        : `${(value / 60000).toFixed(1)} min`;
const clock = (value: string | null) => (value ? new Date(value).toLocaleString() : "—");
export function RunDiagnosticsView({
  pages,
  loading,
  error,
  more,
  onMore,
  onRefresh,
  onAnalyze,
}: {
  pages: RunDiagnostics[];
  loading: boolean;
  error?: string;
  more: boolean;
  onMore: () => void;
  onRefresh: () => void;
  onAnalyze?: (prompt: string) => void | Promise<void>;
}) {
  const [task, setTask] = useState(""),
    [reviewing, setReviewing] = useState(false),
    [notice, setNotice] = useState<string | null>(null);
  const value = pages[0];
  const events = [
    ...new Map(pages.flatMap((page) => page.events).map((event) => [event.id, event])).values(),
  ].sort((a, b) => a.sequence - b.sequence);
  const calls = [
    ...new Map(pages.flatMap((page) => page.calls).map((call) => [call.id, call])).values(),
  ];
  const spans = diagnosticSpans(events.filter((event) => !task || event.taskId === task));
  async function copy() {
    try {
      await navigator.clipboard.writeText(diagnosticAnalysisPrompt(value!, events, calls));
      setNotice("Analysis evidence copied.");
    } catch {
      setNotice("Clipboard unavailable. Download the evidence instead.");
    }
  }
  function download() {
    const url = URL.createObjectURL(
      new Blob(
        [JSON.stringify({ schemaVersion: "openpond.diagnosticBundle.v1", pages }, null, 2)],
        { type: "application/json" },
      ),
    );
    const link = document.createElement("a");
    link.href = url;
    link.download = `diagnostics-${value!.runId}.json`;
    link.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
  return (
    <section className="run-diagnostics" aria-label="Run diagnostics">
      <div className="diagnostic-toolbar">
        <h2>Diagnostics</h2>
        <button type="button" onClick={onRefresh} disabled={loading}>
          Refresh
        </button>
        {value ? (
          <>
            <button type="button" onClick={download}>
              Download evidence
            </button>
            <button type="button" onClick={() => void copy()}>
              Copy analysis context
            </button>
            {onAnalyze ? (
              <button type="button" onClick={() => setReviewing(true)}>
                Investigate in Work
              </button>
            ) : null}
          </>
        ) : null}
      </div>
      {error ? <p role="alert">Diagnostics read failed: {error}</p> : null}
      {loading && !value ? <p role="status">Loading retained diagnostics…</p> : null}
      {notice ? <p role="status">{notice}</p> : null}
      {value ? (
        <>
          <dl className="diagnostic-facts">
            <dt>Execution</dt>
            <dd>{value.status}</dd>
            <dt>Run result evidence</dt>
            <dd>{value.resultAvailable ? "Retained" : "—"}</dd>
            <dt>Started</dt>
            <dd>{clock(value.startedAt)}</dd>
            <dt>Finished</dt>
            <dd>{clock(value.completedAt)}</dd>
            <dt>Elapsed</dt>
            <dd>
              {value.startedAt && value.completedAt
                ? duration(Date.parse(value.completedAt) - Date.parse(value.startedAt))
                : value.startedAt &&
                    ["queued", "running", "cancelling", "in_progress"].includes(value.status)
                  ? "In progress; see live run clock"
                  : "—"}
            </dd>
            <dt>Actual settled spend</dt>
            <dd>
              {money(value.accounting.settledUsd)}
              {value.accounting.settledUsd !== null && !value.accounting.final ? " (partial)" : ""}
            </dd>
            <dt>Spend limit</dt>
            <dd>{money(value.accounting.maximumUsd)}</dd>
          </dl>
          {value.error ? (
            <details open>
              <summary>Failure reason</summary>
              <p className="diagnostic-error">{value.error}</p>
            </details>
          ) : null}
          <div className="diagnostic-toolbar">
            <h3>Timeline</h3>
            <label>
              Task{" "}
              <select value={task} onChange={(event) => setTask(event.target.value)}>
                <option value="">All retained events</option>
                {[...new Set(events.flatMap((event) => (event.taskId ? [event.taskId] : [])))].map(
                  (id) => (
                    <option key={id}>{id}</option>
                  ),
                )}
              </select>
            </label>
          </div>
          <p className="diagnostic-note">
            {events.length} / {value.eventCount} lifecycle events loaded. Durations pair retained
            starts and endings; overlaps are not added together.
          </p>
          <div className="diagnostic-scroll">
            <table>
              <thead>
                <tr>
                  <th>Phase / tool</th>
                  <th>State</th>
                  <th>Started</th>
                  <th>Duration</th>
                  <th>Evidence</th>
                </tr>
              </thead>
              <tbody>
                {spans.map((span) => (
                  <tr key={span.id}>
                    <td>{span.label.replaceAll("_", " ")}</td>
                    <td>{span.status}</td>
                    <td>{clock(span.startedAt)}</td>
                    <td>{duration(span.durationMs)}</td>
                    <td>
                      {span.evidenceIds.map((id) => (
                        <a key={id} href={`#diagnostic-event-${encodeURIComponent(id)}`} title={id}>
                          {id.slice(0, 12)}{" "}
                        </a>
                      ))}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {!spans.length ? <p>No paired phase timings are retained in these pages.</p> : null}
          <h3>Calls and usage</h3>
          <p className="diagnostic-note">
            {calls.length} / {value.callCount} calls loaded. Gateway duration includes transport and
            metering, not just model inference.
          </p>
          <div className="diagnostic-scroll">
            <table>
              <thead>
                <tr>
                  <th>Call</th>
                  <th>Kind / model</th>
                  <th>State</th>
                  <th>Duration</th>
                  <th>Tokens in / out</th>
                  <th>Actual spend</th>
                </tr>
              </thead>
              <tbody>
                {calls.map((call) => (
                  <tr key={call.id}>
                    <td title={call.id}>
                      {call.id.slice(0, 18)}
                      <small title={call.receiptId ?? undefined}>
                        {call.receiptId?.slice(0, 18) ?? "—"}
                      </small>
                    </td>
                    <td>
                      {call.kind}
                      <small>{call.model ?? "—"}</small>
                    </td>
                    <td>{call.status}</td>
                    <td>{duration(call.durationMs)}</td>
                    <td>
                      {call.inputTokens ?? "—"} / {call.outputTokens ?? "—"}
                    </td>
                    <td>{money(call.settledUsd)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {!calls.length ? (
            <p>No call receipts are available. This does not establish zero usage.</p>
          ) : null}
          <details>
            <summary>Lifecycle evidence</summary>
            <div className="diagnostic-scroll">
              <table>
                <thead>
                  <tr>
                    <th>Sequence / ID</th>
                    <th>Recorded at</th>
                    <th>Event</th>
                    <th>Operation / code</th>
                  </tr>
                </thead>
                <tbody>
                  {events
                    .filter((event) => !task || event.taskId === task)
                    .map((event) => (
                      <tr key={event.id} id={`diagnostic-event-${encodeURIComponent(event.id)}`}>
                        <td>
                          {event.sequence}
                          <small title={event.id}>{event.id}</small>
                        </td>
                        <td>{clock(event.at)}</td>
                        <td>{event.type}</td>
                        <td>{event.action ?? event.errorCode ?? "—"}</td>
                      </tr>
                    ))}
                </tbody>
              </table>
            </div>
          </details>
          {more ? (
            <button type="button" disabled={loading} onClick={onMore}>
              Load more evidence
            </button>
          ) : null}
          <details>
            <summary>Resources and accounting</summary>
            <dl className="diagnostic-facts">
              <dt>Location</dt>
              <dd>{value.location}</dd>
              <dt>Parent</dt>
              <dd>{value.parent?.id ?? "—"}</dd>
              <dt>Attempt</dt>
              <dd>{value.parent?.attempt ?? "—"}</dd>
              <dt>Heartbeat</dt>
              <dd>{clock(value.parent?.heartbeatAt ?? null)}</dd>
              <dt>Lease until</dt>
              <dd>{clock(value.parent?.leaseExpiresAt ?? null)}</dd>
              <dt>Sandbox released</dt>
              <dd>{clock(value.parent?.releasedAt ?? null)}</dd>
              <dt>Unsettled reservations</dt>
              <dd>
                {value.accounting.outstandingCount ?? "—"} /{" "}
                {money(value.accounting.outstandingUsd)}
              </dd>
              <dt>Accounting</dt>
              <dd>{value.accounting.final ? "Final" : "Incomplete"}</dd>
            </dl>
          </details>
          <details>
            <summary>Scope and limitations</summary>
            <dl className="diagnostic-facts">
              <dt>Workspace</dt>
              <dd>{value.teamId}</dd>
              <dt>Run</dt>
              <dd>{value.runId}</dd>
              <dt>Immutable identity</dt>
              <dd>{value.manifestHash}</dd>
              <dt>Observed</dt>
              <dd>{clock(value.observedAt)}</dd>
            </dl>
            <ul>
              {value.limitations.map((note) => (
                <li key={note}>{note}</li>
              ))}
            </ul>
          </details>
          {reviewing ? (
            <div
              className="diagnostic-review"
              role="dialog"
              aria-modal="false"
              aria-label="Review investigation draft"
            >
              <h3>Investigate this run</h3>
              <p>
                Opens a new Work draft with this run’s metadata and evidence IDs. Choose a
                configured model or coding agent and repository in Work before sending. Review its
                permissions and normal usage controls. This button does not launch paid analysis.
                The original experiment will not be replayed or changed. The resulting conversation
                retains the investigation separately.
              </p>
              <details>
                <summary>Review shared metadata</summary>
                <pre>{diagnosticAnalysisPrompt(value, events, calls)}</pre>
              </details>
              <button
                type="button"
                onClick={() => {
                  void Promise.resolve()
                    .then(() => onAnalyze?.(diagnosticAnalysisPrompt(value, events, calls)))
                    .then(() => setReviewing(false))
                    .catch(() =>
                      setNotice(
                        "Could not open the investigation draft. Download the evidence or retry.",
                      ),
                    );
                }}
              >
                Open Work draft
              </button>
              <button type="button" onClick={() => setReviewing(false)}>
                Close
              </button>
            </div>
          ) : null}
        </>
      ) : null}
    </section>
  );
}
