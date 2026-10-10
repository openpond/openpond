import { useRef, useState, type ReactNode } from "react";
import { ChevronRight } from "lucide-react";
import {
  diagnosticAnalysisPrompt,
  diagnosticSpans,
  type RunDiagnostics,
} from "openpond-sdk/experiments";
import { DropdownSelect } from "../../DropdownSelect";
import { EvaluationStatus } from "./EvaluationPresentation";
import "../../../styles/labs/evaluation-workspace.css";
import "../../../styles/labs/run-diagnostics.css";

const exactMoney = (value: number | null) => (value === null ? "—" : `$${value.toFixed(6)}`);
/** Cents are enough to scan; the exact settled amount stays in the title. */
const money = (value: number | null) =>
  value === null
    ? "—"
    : value === 0 || value >= 0.01
      ? `$${value.toFixed(2)}`
      : `$${value.toFixed(6).replace(/0+$/, "")}`;
const duration = (value: number | null) =>
  value === null
    ? "—"
    : value < 1000
      ? `${value} ms`
      : value < 60000
        ? `${(value / 1000).toFixed(1)} s`
        : `${(value / 60000).toFixed(1)} min`;
const clock = (value: string | null) => (value ? new Date(value).toLocaleString() : "—");
const shortClock = (value: string | null) =>
  value
    ? new Date(value).toLocaleString(undefined, {
        month: "short",
        day: "numeric",
        hour: "numeric",
        minute: "2-digit",
        second: "2-digit",
      })
    : "—";
const tokens = (value: number | null) => (value === null ? "—" : value.toLocaleString());

function Disclosure({
  title,
  meta,
  children,
  detailsRef,
}: {
  title: string;
  meta?: string;
  children: ReactNode;
  detailsRef?: React.Ref<HTMLDetailsElement>;
}) {
  return (
    <details className="diagnostic-disclosure" ref={detailsRef}>
      <summary>
        <ChevronRight size={14} aria-hidden="true" />
        <span>{title}</span>
        {meta ? <small>{meta}</small> : null}
      </summary>
      <div className="diagnostic-disclosure-body">{children}</div>
    </details>
  );
}

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
  const [task, setTask] = useState(
      () =>
        new URLSearchParams(typeof window === "undefined" ? "" : window.location.hash.slice(1))
          .get("diagnostic-task")
          ?.slice(0, 500) ?? "",
    ),
    [attempt, setAttempt] = useState(
      () =>
        new URLSearchParams(typeof window === "undefined" ? "" : window.location.hash.slice(1)).get(
          "diagnostic-attempt",
        ) ?? "",
    ),
    [reviewing, setReviewing] = useState(false),
    [notice, setNotice] = useState<string | null>(null);
  const evidenceDetails = useRef<HTMLDetailsElement>(null);
  const value = pages[0];
  const events = [
    ...new Map(pages.flatMap((page) => page.events).map((event) => [event.id, event])).values(),
  ].sort((a, b) => a.sequence - b.sequence);
  const calls = [
    ...new Map(pages.flatMap((page) => page.calls).map((call) => [call.id, call])).values(),
  ];
  const taskIds = [...new Set(events.flatMap((event) => (event.taskId ? [event.taskId] : [])))];
  const attempts = [
    ...new Set(events.flatMap((event) => (event.attempt === null ? [] : [event.attempt]))),
  ].sort((a, b) => a - b);
  const selectedEvents = events.filter(
    (event) => (!task || event.taskId === task) && (!attempt || String(event.attempt) === attempt),
  );
  const eventById = new Map(events.map((event) => [event.id, event]));
  const spans = diagnosticSpans(selectedEvents);
  function selectEvidence(nextTask: string, nextAttempt: string) {
    setTask(nextTask);
    setAttempt(nextAttempt);
    const selection = new URLSearchParams();
    if (nextTask) selection.set("diagnostic-task", nextTask);
    if (nextAttempt) selection.set("diagnostic-attempt", nextAttempt);
    window.history.replaceState(
      window.history.state,
      "",
      `${window.location.pathname}${window.location.search}${selection.size ? `#${selection}` : ""}`,
    );
  }
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
  const elapsed = value
    ? value.startedAt && value.completedAt
      ? duration(Date.parse(value.completedAt) - Date.parse(value.startedAt))
      : value.startedAt && ["queued", "running", "cancelling", "in_progress"].includes(value.status)
        ? "In progress"
        : "—"
    : "—";
  return (
    <section className="run-diagnostics" aria-label="Run diagnostics">
      <header className="diagnostic-header">
        <div>
          <h2>Diagnostics</h2>
          <p className="diagnostic-note">
            Retained lifecycle events, model calls and accounting for this run.
          </p>
        </div>
        <div className="diagnostic-actions">
          <button
            type="button"
            className="training-button secondary"
            onClick={onRefresh}
            disabled={loading}
          >
            {loading && value ? "Refreshing…" : "Refresh"}
          </button>
          {value ? (
            <>
              <button type="button" className="training-button secondary" onClick={download}>
                Download evidence
              </button>
              <button
                type="button"
                className="training-button secondary"
                onClick={() => void copy()}
              >
                Copy analysis context
              </button>
              {onAnalyze ? (
                <button
                  type="button"
                  className="training-button"
                  aria-expanded={reviewing}
                  onClick={() => setReviewing(true)}
                >
                  Investigate in Work
                </button>
              ) : null}
            </>
          ) : null}
        </div>
      </header>
      {error ? (
        <p className="diagnostic-callout diagnostic-callout-error" role="alert">
          Diagnostics read failed: {error}
        </p>
      ) : null}
      {loading && !value ? (
        <p className="diagnostic-note" role="status">
          Loading retained diagnostics…
        </p>
      ) : null}
      {notice ? (
        <p className="diagnostic-note" role="status">
          {notice}
        </p>
      ) : null}
      {value && reviewing ? (
        <div
          className="diagnostic-review"
          role="dialog"
          aria-modal="false"
          aria-label="Review investigation draft"
        >
          <h3>Investigate this run</h3>
          <p>
            Opens a new Work draft with this run’s metadata and evidence IDs. Choose a configured
            model or coding agent and repository in Work before sending. Review its permissions and
            normal usage controls. This button does not launch paid analysis. The original
            experiment will not be replayed or changed. The resulting conversation retains the
            investigation separately.
          </p>
          <Disclosure title="Review shared metadata">
            <pre>{diagnosticAnalysisPrompt(value, events, calls)}</pre>
          </Disclosure>
          <div className="diagnostic-actions">
            <button
              type="button"
              className="training-button"
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
            <button
              type="button"
              className="training-button secondary"
              onClick={() => setReviewing(false)}
            >
              Cancel
            </button>
          </div>
        </div>
      ) : null}
      {value ? (
        <>
          {value.error ? (
            <div className="diagnostic-callout diagnostic-callout-error">
              <strong>Failure reason</strong>
              <code>{value.error}</code>
            </div>
          ) : null}
          <dl className="diagnostic-stats">
            <div>
              <dt>Execution</dt>
              <dd>
                <EvaluationStatus status={value.status} />
              </dd>
            </div>
            <div>
              <dt>Started</dt>
              <dd title={clock(value.startedAt)}>{shortClock(value.startedAt)}</dd>
            </div>
            <div>
              <dt>Finished</dt>
              <dd title={clock(value.completedAt)}>{shortClock(value.completedAt)}</dd>
            </div>
            <div>
              <dt>Elapsed</dt>
              <dd>{elapsed}</dd>
            </div>
            <div>
              <dt>Settled spend</dt>
              <dd title={exactMoney(value.accounting.settledUsd)}>
                {money(value.accounting.settledUsd)}
                {value.accounting.settledUsd !== null && !value.accounting.final ? (
                  <small> partial</small>
                ) : null}
              </dd>
            </div>
            <div>
              <dt>Spend limit</dt>
              <dd title={exactMoney(value.accounting.maximumUsd)}>
                {money(value.accounting.maximumUsd)}
              </dd>
            </div>
            <div>
              <dt>Run result</dt>
              <dd>{value.resultAvailable ? "Retained" : "Not retained"}</dd>
            </div>
          </dl>
          <section className="diagnostic-section" aria-label="Timeline">
            <div className="diagnostic-section-header">
              <div>
                <h3>Timeline</h3>
                <p className="diagnostic-note">
                  {events.length} of {value.eventCount} lifecycle events loaded. Durations pair
                  retained starts and endings; overlaps are not added together.
                </p>
              </div>
              {taskIds.length || attempts.length ? (
                <div className="diagnostic-filters">
                  {taskIds.length ? (
                    <DropdownSelect
                      className="diagnostic-filter"
                      label="Task"
                      searchable={taskIds.length > 8}
                      value={task}
                      options={[
                        { value: "", label: "All tasks" },
                        ...(task && !taskIds.includes(task)
                          ? [{ value: task, label: task }]
                          : []),
                        ...taskIds.map((id) => ({ value: id, label: id })),
                      ]}
                      onChange={(next) => selectEvidence(next, attempt)}
                    />
                  ) : null}
                  {attempts.length ? (
                    <DropdownSelect
                      className="diagnostic-filter"
                      label="Attempt"
                      value={attempt}
                      options={[
                        { value: "", label: "All attempts" },
                        ...attempts.map((value) => ({
                          value: String(value),
                          label: `Attempt ${value}`,
                        })),
                      ]}
                      onChange={(next) => selectEvidence(task, next)}
                    />
                  ) : null}
                </div>
              ) : null}
            </div>
            <div className="diagnostic-table">
              <table>
                <thead>
                  <tr>
                    <th>Phase / tool</th>
                    <th>Attempt</th>
                    <th>State</th>
                    <th>Started</th>
                    <th className="diagnostic-numeric">Duration</th>
                    <th>Evidence</th>
                  </tr>
                </thead>
                <tbody>
                  {spans.map((span) => (
                    <tr key={span.id}>
                      <td>{span.label.replaceAll("_", " ")}</td>
                      <td>{eventById.get(span.id)?.attempt ?? "—"}</td>
                      <td>
                        <EvaluationStatus status={span.status} />
                      </td>
                      <td title={clock(span.startedAt)}>{shortClock(span.startedAt)}</td>
                      <td className="diagnostic-numeric">{duration(span.durationMs)}</td>
                      <td>
                        <span className="diagnostic-chips">
                          {span.evidenceIds.map((id) => (
                            <a
                              key={id}
                              className="diagnostic-chip"
                              href={`#${new URLSearchParams({ "diagnostic-task": task, "diagnostic-attempt": attempt, event: id })}`}
                              title={`Show lifecycle event ${id}`}
                              onClick={() => {
                                if (evidenceDetails.current) evidenceDetails.current.open = true;
                              }}
                            >
                              {id.slice(0, 10)}
                            </a>
                          ))}
                        </span>
                      </td>
                    </tr>
                  ))}
                  {!spans.length ? (
                    <tr>
                      <td colSpan={6} className="diagnostic-empty">
                        No paired phase timings are retained in these pages.
                      </td>
                    </tr>
                  ) : null}
                </tbody>
              </table>
            </div>
          </section>
          <section className="diagnostic-section" aria-label="Calls and usage">
            <div className="diagnostic-section-header">
              <div>
                <h3>Calls and usage</h3>
                <p className="diagnostic-note">
                  {calls.length} of {value.callCount} calls loaded. Gateway duration includes
                  transport and metering, not just model inference.
                </p>
              </div>
            </div>
            <div className="diagnostic-table">
              <table>
                <thead>
                  <tr>
                    <th>Call</th>
                    <th>Kind / model</th>
                    <th>State</th>
                    <th className="diagnostic-numeric">Duration</th>
                    <th className="diagnostic-numeric">Tokens in / out</th>
                    <th className="diagnostic-numeric">Actual spend</th>
                  </tr>
                </thead>
                <tbody>
                  {calls.map((call) => (
                    <tr key={call.id}>
                      <td>
                        <code title={call.id}>{call.id.slice(0, 18)}</code>
                        <small title={call.receiptId ?? undefined}>
                          {call.receiptId?.slice(0, 18) ?? "No receipt"}
                        </small>
                      </td>
                      <td>
                        {call.kind}
                        <small>{call.model ?? "—"}</small>
                      </td>
                      <td>
                        <EvaluationStatus status={call.status} />
                      </td>
                      <td className="diagnostic-numeric">{duration(call.durationMs)}</td>
                      <td className="diagnostic-numeric">
                        {tokens(call.inputTokens)} / {tokens(call.outputTokens)}
                      </td>
                      <td className="diagnostic-numeric" title={exactMoney(call.settledUsd)}>
                        {money(call.settledUsd)}
                      </td>
                    </tr>
                  ))}
                  {!calls.length ? (
                    <tr>
                      <td colSpan={6} className="diagnostic-empty">
                        No call receipts are available. This does not establish zero usage.
                      </td>
                    </tr>
                  ) : null}
                </tbody>
              </table>
            </div>
          </section>
          <div className="diagnostic-disclosures">
            <Disclosure
              title="Lifecycle evidence"
              meta={`${selectedEvents.length} events`}
              detailsRef={evidenceDetails}
            >
              <div className="diagnostic-table">
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
                    {selectedEvents.map((event) => (
                      <tr
                        key={event.id}
                        id={new URLSearchParams({
                          "diagnostic-task": task,
                          "diagnostic-attempt": attempt,
                          event: event.id,
                        }).toString()}
                      >
                        <td>
                          {event.sequence}
                          <small title={event.id}>{event.id}</small>
                        </td>
                        <td title={clock(event.at)}>{shortClock(event.at)}</td>
                        <td>{event.type}</td>
                        <td>{event.action ?? event.errorCode ?? "—"}</td>
                      </tr>
                    ))}
                    {!selectedEvents.length ? (
                      <tr>
                        <td colSpan={4} className="diagnostic-empty">
                          No lifecycle events match this selection.
                        </td>
                      </tr>
                    ) : null}
                  </tbody>
                </table>
              </div>
            </Disclosure>
            <Disclosure
              title="Resources and accounting"
              meta={value.accounting.final ? "Final" : "Incomplete"}
            >
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
                  {exactMoney(value.accounting.outstandingUsd)}
                </dd>
                <dt>Settled spend</dt>
                <dd>{exactMoney(value.accounting.settledUsd)}</dd>
                <dt>Accounting</dt>
                <dd>{value.accounting.final ? "Final" : "Incomplete"}</dd>
              </dl>
            </Disclosure>
            <Disclosure title="Scope and limitations">
              <dl className="diagnostic-facts">
                <dt>Workspace</dt>
                <dd>
                  <code>{value.teamId}</code>
                </dd>
                <dt>Run</dt>
                <dd>
                  <code>{value.runId}</code>
                </dd>
                <dt>Immutable identity</dt>
                <dd>
                  <code>{value.manifestHash}</code>
                </dd>
                <dt>Observed</dt>
                <dd>{clock(value.observedAt)}</dd>
              </dl>
              {value.limitations.length ? (
                <ul>
                  {value.limitations.map((note) => (
                    <li key={note}>{note}</li>
                  ))}
                </ul>
              ) : null}
            </Disclosure>
          </div>
          {more ? (
            <button
              type="button"
              className="training-button secondary diagnostic-more"
              disabled={loading}
              onClick={onMore}
            >
              {loading ? "Loading evidence…" : "Load more evidence"}
            </button>
          ) : null}
        </>
      ) : null}
    </section>
  );
}
