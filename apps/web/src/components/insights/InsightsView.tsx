import type {
  InsightItem,
  InsightRun,
  InsightEvidenceSource,
  InsightRunTrigger,
  InsightRunStatus,
  InsightSeverity,
  InsightStatus,
} from "@openpond/contracts";
import { useEffect, useMemo, useState } from "react";
import "../../styles/insights/insights.css";
import { CheckCircle2, RefreshCw, X } from "../icons";

export type InsightsViewProps = {
  enabled: boolean;
  items: InsightItem[];
  runs: InsightRun[];
  nextScanAt: string | null;
  scanRunning: boolean;
  scanStartedAt: string | null;
  scanning: boolean;
  savingEnabled: boolean;
  error: string | null;
  onEnabledChange: (enabled: boolean) => Promise<void>;
  onPatchStatus: (insightId: string, status: InsightStatus) => Promise<unknown>;
  onOpenSession: (sessionId: string) => void;
};

export function InsightsView({
  enabled,
  items,
  runs,
  nextScanAt,
  scanRunning,
  scanStartedAt,
  scanning,
  savingEnabled,
  error,
  onEnabledChange,
  onPatchStatus,
  onOpenSession,
}: InsightsViewProps) {
  const [statusFilter, setStatusFilter] = useState<InsightStatus | "all">("all");
  const [severityFilter, setSeverityFilter] = useState<InsightSeverity | "all">("all");
  const [sourceFilter, setSourceFilter] = useState<InsightEvidenceSource | "all">("all");
  const [runStatusFilter, setRunStatusFilter] = useState<InsightRunStatus | "all">("all");
  const [runTriggerFilter, setRunTriggerFilter] = useState<InsightRunTrigger | "all">("all");
  const [nowMs, setNowMs] = useState(() => Date.now());
  useEffect(() => {
    const interval = window.setInterval(() => setNowMs(Date.now()), 1000);
    return () => window.clearInterval(interval);
  }, []);
  const filteredItems = useMemo(
    () =>
      items.filter((item) => {
        if (statusFilter !== "all" && item.status !== statusFilter) return false;
        if (severityFilter !== "all" && item.severity !== severityFilter) return false;
        if (sourceFilter !== "all" && itemEvidenceSource(item) !== sourceFilter) return false;
        return true;
      }),
    [items, severityFilter, sourceFilter, statusFilter],
  );
  const filteredRuns = useMemo(
    () =>
      runs.filter((run) => {
        if (runStatusFilter !== "all" && run.status !== runStatusFilter) return false;
        if (runTriggerFilter !== "all" && run.trigger !== runTriggerFilter) return false;
        if (sourceFilter !== "all" && !run.evidenceSources.includes(sourceFilter)) return false;
        return true;
      }),
    [runStatusFilter, runTriggerFilter, runs, sourceFilter],
  );
  const activeItems = useMemo(
    () => filteredItems.filter((item) => item.status === "active"),
    [filteredItems],
  );
  const inactiveItems = useMemo(
    () => filteredItems.filter((item) => item.status !== "active"),
    [filteredItems],
  );
  const showActiveSection = statusFilter === "all" || statusFilter === "active";
  const showRecentSection = statusFilter === "all" || statusFilter !== "active";
  const isScanRunning = scanning || scanRunning;
  const observationPaginationKey = `${statusFilter}:${severityFilter}:${sourceFilter}`;
  const runPaginationKey = `${runStatusFilter}:${runTriggerFilter}:${sourceFilter}`;
  return (
    <section className="insights-view" aria-label="Insights">
      <section className="insights-scan-preference" aria-label="Observation scanning">
        <div>
          <strong>Observation scanning</strong>
          <span>
            Periodically review selected work, failures, and corrections for signals. It stays off until you turn it on.
          </span>
        </div>
        <div className="insights-scan-controls">
          <span className={`insights-scan-countdown ${isScanRunning ? "running" : ""}`}>
            <span className="insights-scan-dot" aria-hidden="true" />
            {enabled ? formatNextScanCountdown(nextScanAt, nowMs, isScanRunning) : "Scanning is off"}
          </span>
          <button
            aria-pressed={enabled}
            className={enabled ? "active" : undefined}
            disabled={savingEnabled || isScanRunning}
            type="button"
            onClick={() => void onEnabledChange(!enabled)}
          >
            {savingEnabled ? "Saving" : enabled ? "On" : "Turn on"}
          </button>
        </div>
      </section>

      <div className="insights-filters" aria-label="Insight filters">
        <FilterSelect
          label="Observation status"
          options={STATUS_FILTER_OPTIONS}
          value={statusFilter}
          onChange={setStatusFilter}
        />
        <FilterSelect
          label="Severity"
          options={SEVERITY_FILTER_OPTIONS}
          value={severityFilter}
          onChange={setSeverityFilter}
        />
        <FilterSelect
          label="Source"
          options={SOURCE_FILTER_OPTIONS}
          value={sourceFilter}
          onChange={setSourceFilter}
        />
        <FilterSelect
          label="Run status"
          options={RUN_STATUS_FILTER_OPTIONS}
          value={runStatusFilter}
          onChange={setRunStatusFilter}
        />
        <FilterSelect
          label="Run trigger"
          options={RUN_TRIGGER_FILTER_OPTIONS}
          value={runTriggerFilter}
          onChange={setRunTriggerFilter}
        />
      </div>

      {isScanRunning ? (
        <div className="insights-active-scan" role="status">
          <span className="insights-scan-dot" aria-hidden="true" />
          <div>
            <strong>Active scan</strong>
            <span>{scanStartedAt ? `Started ${formatTimestamp(scanStartedAt)}` : "Scanning insights now"}</span>
          </div>
        </div>
      ) : null}

      {error ? <div className="insights-error">{error}</div> : null}

      <InsightRuns
        runs={filteredRuns}
        paginationKey={runPaginationKey}
        onOpenSession={onOpenSession}
      />

      {showActiveSection ? (
        <InsightRows
          title="Active"
          emptyText="No active Create/Improve insights match the filters."
          items={activeItems}
          paginationKey={observationPaginationKey}
          onPatchStatus={onPatchStatus}
          onOpenSession={onOpenSession}
        />
      ) : null}
      {showRecentSection ? (
        <InsightRows
          title="Recent"
          emptyText="No resolved or dismissed insights match the filters."
          items={inactiveItems}
          paginationKey={observationPaginationKey}
          onPatchStatus={onPatchStatus}
          onOpenSession={onOpenSession}
        />
      ) : null}
    </section>
  );
}

const STATUS_FILTER_OPTIONS: Array<{ value: InsightStatus | "all"; label: string }> = [
  { value: "all", label: "All" },
  { value: "active", label: "Active" },
  { value: "resolved", label: "Resolved" },
  { value: "dismissed", label: "Dismissed" },
];

const SEVERITY_FILTER_OPTIONS: Array<{ value: InsightSeverity | "all"; label: string }> = [
  { value: "all", label: "All" },
  { value: "blocker", label: "Blocker" },
  { value: "concern", label: "Concern" },
  { value: "nit", label: "Nit" },
];

const SOURCE_FILTER_OPTIONS: Array<{ value: InsightEvidenceSource | "all"; label: string }> = [
  { value: "all", label: "All" },
  { value: "create_edit", label: "Create/Improve" },
  { value: "stuck_turn", label: "Stuck turns" },
  { value: "tool_failure", label: "Tools" },
  { value: "abandoned_goal", label: "Goals" },
  { value: "user_correction", label: "Corrections" },
  { value: "unresolved_conversation", label: "Unresolved" },
  { value: "usage_anomaly", label: "Usage" },
];

const RUN_STATUS_FILTER_OPTIONS: Array<{ value: InsightRunStatus | "all"; label: string }> = [
  { value: "all", label: "All" },
  { value: "running", label: "Running" },
  { value: "completed", label: "Completed" },
  { value: "failed", label: "Failed" },
  { value: "skipped", label: "Skipped" },
];

const RUN_TRIGGER_FILTER_OPTIONS: Array<{ value: InsightRunTrigger | "all"; label: string }> = [
  { value: "all", label: "All" },
  { value: "manual", label: "Manual" },
  { value: "interval", label: "Interval" },
  { value: "startup", label: "Startup" },
  { value: "slash_command", label: "Slash" },
];

function FilterSelect<T extends string>({
  label,
  options,
  value,
  onChange,
}: {
  label: string;
  options: Array<{ value: T; label: string }>;
  value: T;
  onChange: (value: T) => void;
}) {
  return (
    <label className="insights-filter-group">
      <span>{label}</span>
      <select value={value} onChange={(event) => onChange(event.target.value as T)}>
        {options.map((option) => (
          <option key={option.value} value={option.value}>{option.label}</option>
        ))}
      </select>
    </label>
  );
}

function InsightRows({
  title,
  emptyText,
  items,
  paginationKey,
  onPatchStatus,
  onOpenSession,
}: {
  title: string;
  emptyText: string;
  items: InsightItem[];
  paginationKey: string;
  onPatchStatus: (insightId: string, status: InsightStatus) => Promise<unknown>;
  onOpenSession: (sessionId: string) => void;
}) {
  const pagination = useTablePagination(items, paginationKey);
  return (
    <section className="insights-section">
      <h2>{title}</h2>
      {items.length === 0 ? (
        <p className="insights-empty">{emptyText}</p>
      ) : (
        <div className="insights-table-frame">
          <div className="insights-table-scroll">
            <table className="insights-table insights-observations-table">
              <thead>
                <tr>
                  <th scope="col">Severity</th>
                  <th scope="col">Status</th>
                  <th scope="col">Observation</th>
                  <th scope="col">Updated</th>
                  <th scope="col">Actions</th>
                </tr>
              </thead>
              <tbody>
                {pagination.pageItems.map((item) => (
                  <tr key={item.id}>
                    <td>
                      <span className={`insights-severity ${item.severity}`}>
                        {severityLabel(item.severity)}
                      </span>
                    </td>
                    <td>
                      <div className="insights-status-stack">
                        <span>{item.status}</span>
                        <small>{evidenceSourceLabel(itemEvidenceSource(item))}</small>
                      </div>
                    </td>
                    <td>
                      <div className="insights-copy">
                        <strong>{item.title}</strong>
                        <span>{item.summary}</span>
                      </div>
                    </td>
                    <td className="insights-time">{formatTimestamp(item.updatedAt)}</td>
                    <td>
                      <div className="insights-actions">
                        {payloadString(item.payload.sessionId) ? (
                          <button
                            type="button"
                            className="insights-text-action"
                            onClick={() => onOpenSession(payloadString(item.payload.sessionId)!)}
                          >
                            Source
                          </button>
                        ) : null}
                        {item.lastRunSessionId ? (
                          <button type="button" className="insights-text-action" onClick={() => onOpenSession(item.lastRunSessionId!)}>
                            Run
                          </button>
                        ) : null}
                        {item.status === "active" ? (
                          <>
                            <button
                              type="button"
                              title="Resolve observation"
                              aria-label="Resolve observation"
                              onClick={() => void onPatchStatus(item.id, "resolved")}
                            >
                              <CheckCircle2 size={15} />
                            </button>
                            <button
                              type="button"
                              title="Dismiss observation"
                              aria-label="Dismiss observation"
                              onClick={() => void onPatchStatus(item.id, "dismissed")}
                            >
                              <X size={15} />
                            </button>
                          </>
                        ) : (
                          <button
                            type="button"
                            title="Reopen observation"
                            aria-label="Reopen observation"
                            onClick={() => void onPatchStatus(item.id, "active")}
                          >
                            <RefreshCw size={15} />
                          </button>
                        )}
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <TablePagination label={title} {...pagination} />
        </div>
      )}
    </section>
  );
}

function InsightRuns({
  runs,
  paginationKey,
  onOpenSession,
}: {
  runs: InsightRun[];
  paginationKey: string;
  onOpenSession: (sessionId: string) => void;
}) {
  const pagination = useTablePagination(runs, paginationKey);
  return (
    <section className="insights-section">
      <h2>Runs</h2>
      {runs.length === 0 ? (
        <p className="insights-empty">No Insights runs yet.</p>
      ) : (
        <div className="insights-table-frame">
          <div className="insights-table-scroll">
            <table className="insights-table insights-runs-table">
              <thead>
                <tr>
                  <th scope="col">Trigger</th>
                  <th scope="col">Status</th>
                  <th scope="col">Model</th>
                  <th scope="col">Summary</th>
                  <th scope="col">Completed</th>
                  <th scope="col">Actions</th>
                </tr>
              </thead>
              <tbody>
                {pagination.pageItems.map((run) => (
                  <tr key={run.turnId}>
                    <td>{triggerLabel(run.trigger)}</td>
                    <td className="insights-status">{run.status}</td>
                    <td className="insights-status">{runModelLabel(run)}</td>
                    <td>
                      <div className="insights-copy">
                        <strong>{run.summary ?? `${run.findingCount} finding${run.findingCount === 1 ? "" : "s"}`}</strong>
                        <span>
                          {run.createdCount} new / {run.updatedCount} updated / {run.resolvedCount} resolved
                        </span>
                      </div>
                    </td>
                    <td className="insights-time">{formatTimestamp(run.completedAt ?? run.startedAt)}</td>
                    <td>
                      <div className="insights-actions">
                        <button type="button" className="insights-text-action" onClick={() => onOpenSession(run.sessionId)}>
                          Open run
                        </button>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <TablePagination label="Runs" {...pagination} />
        </div>
      )}
    </section>
  );
}

const TABLE_PAGE_SIZE = 10;

function useTablePagination<T>(items: T[], resetKey: string) {
  const [requestedPageIndex, setRequestedPageIndex] = useState(0);
  useEffect(() => setRequestedPageIndex(0), [resetKey]);
  const pageCount = Math.max(1, Math.ceil(items.length / TABLE_PAGE_SIZE));
  const pageIndex = Math.min(requestedPageIndex, pageCount - 1);
  const pageStart = pageIndex * TABLE_PAGE_SIZE;
  return {
    pageItems: items.slice(pageStart, pageStart + TABLE_PAGE_SIZE),
    pageIndex,
    pageCount,
    pageStart,
    pageSize: TABLE_PAGE_SIZE,
    totalItems: items.length,
    onPageChange: setRequestedPageIndex,
  };
}

function TablePagination({
  label,
  pageIndex,
  pageCount,
  pageStart,
  pageSize,
  totalItems,
  onPageChange,
}: {
  label: string;
  pageIndex: number;
  pageCount: number;
  pageStart: number;
  pageSize: number;
  totalItems: number;
  onPageChange: (pageIndex: number) => void;
}) {
  return (
    <nav className="insights-pagination" aria-label={`${label} pagination`}>
      <span>{pageStart + 1}–{Math.min(pageStart + pageSize, totalItems)} of {totalItems}</span>
      <div>
        <button
          type="button"
          disabled={pageIndex === 0}
          onClick={() => onPageChange(pageIndex - 1)}
        >
          Previous
        </button>
        <span>Page {pageIndex + 1} of {pageCount}</span>
        <button
          type="button"
          disabled={pageIndex >= pageCount - 1}
          onClick={() => onPageChange(pageIndex + 1)}
        >
          Next
        </button>
      </div>
    </nav>
  );
}

function severityLabel(severity: InsightSeverity): string {
  if (severity === "blocker") return "Blocker";
  if (severity === "concern") return "Concern";
  return "Nit";
}

function formatNextScanCountdown(nextScanAt: string | null, nowMs: number, scanRunning: boolean): string {
  if (scanRunning) return "Scanning now";
  if (!nextScanAt) return "Next scan not scheduled";
  const targetMs = new Date(nextScanAt).getTime();
  if (Number.isNaN(targetMs)) return "Next scan not scheduled";
  const remainingMs = targetMs - nowMs;
  if (remainingMs <= 0) return "Next scan starting soon";
  const minutes = Math.ceil(remainingMs / 60_000);
  return `${minutes} minute${minutes === 1 ? "" : "s"} till next scan`;
}

function triggerLabel(trigger: InsightRunTrigger): string {
  if (trigger === "slash_command") return "Slash command";
  if (trigger === "startup") return "Startup";
  if (trigger === "interval") return "Interval";
  return "Manual";
}

function runModelLabel(run: InsightRun): string {
  if (!run.modelRef) return "Default";
  return `${run.modelRef.providerId} / ${run.modelRef.modelId}`;
}

function itemEvidenceSource(item: InsightItem): InsightEvidenceSource {
  const value = item.payload.evidenceSource;
  if (
    value === "create_edit" ||
    value === "stuck_turn" ||
    value === "tool_failure" ||
    value === "abandoned_goal" ||
    value === "user_correction" ||
    value === "unresolved_conversation" ||
    value === "usage_anomaly"
  ) {
    return value;
  }
  return "create_edit";
}

function evidenceSourceLabel(source: InsightEvidenceSource): string {
  if (source === "stuck_turn") return "Stuck turn";
  if (source === "tool_failure") return "Tool failures";
  if (source === "abandoned_goal") return "Abandoned goal";
  if (source === "user_correction") return "Corrections";
  if (source === "unresolved_conversation") return "Unresolved chat";
  if (source === "usage_anomaly") return "Usage";
  return "Create/Improve";
}

function payloadString(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value : null;
}

function formatTimestamp(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return new Intl.DateTimeFormat(undefined, {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  }).format(date);
}
