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
import { CheckCircle2, RefreshCw, X } from "../icons";

type InsightsViewProps = {
  items: InsightItem[];
  runs: InsightRun[];
  nextScanAt: string | null;
  scanRunning: boolean;
  scanStartedAt: string | null;
  scanning: boolean;
  error: string | null;
  onRunScan: () => Promise<unknown>;
  onPatchStatus: (insightId: string, status: InsightStatus) => Promise<unknown>;
  onOpenSession: (sessionId: string) => void;
};

export function InsightsView({
  items,
  runs,
  nextScanAt,
  scanRunning,
  scanStartedAt,
  scanning,
  error,
  onRunScan,
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
  const activeItems = filteredItems.filter((item) => item.status === "active");
  const inactiveItems = filteredItems.filter((item) => item.status !== "active");
  const showActiveSection = statusFilter === "all" || statusFilter === "active";
  const showRecentSection = statusFilter === "all" || statusFilter !== "active";
  const isScanRunning = scanning || scanRunning;
  return (
    <section className="insights-view" aria-label="Insights">
      <div className="insights-filters" aria-label="Insight filters">
        <SegmentedFilter
          label="Status"
          hideLabel
          options={STATUS_FILTER_OPTIONS}
          value={statusFilter}
          onChange={setStatusFilter}
        />
        <SegmentedFilter
          label="Severity"
          options={SEVERITY_FILTER_OPTIONS}
          value={severityFilter}
          onChange={setSeverityFilter}
        />
        <SegmentedFilter
          label="Source"
          options={SOURCE_FILTER_OPTIONS}
          value={sourceFilter}
          onChange={setSourceFilter}
        />
        <SegmentedFilter
          label="Run status"
          options={RUN_STATUS_FILTER_OPTIONS}
          value={runStatusFilter}
          onChange={setRunStatusFilter}
        />
        <SegmentedFilter
          label="Run trigger"
          options={RUN_TRIGGER_FILTER_OPTIONS}
          value={runTriggerFilter}
          onChange={setRunTriggerFilter}
        />
        <button
          type="button"
          className="insights-scan-button"
          aria-busy={isScanRunning}
          disabled={isScanRunning}
          onClick={() => void onRunScan()}
        >
          <span>Scan</span>
        </button>
        <span className={`insights-scan-countdown ${isScanRunning ? "running" : ""}`}>
          <span className="insights-scan-dot" aria-hidden="true" />
          {formatNextScanCountdown(nextScanAt, nowMs, isScanRunning)}
        </span>
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

      <InsightRuns runs={filteredRuns} onOpenSession={onOpenSession} />

      {showActiveSection ? (
        <InsightRows
          title="Active"
          emptyText="No active create/edit insights match the filters."
          items={activeItems}
          onPatchStatus={onPatchStatus}
          onOpenSession={onOpenSession}
        />
      ) : null}
      {showRecentSection ? (
        <InsightRows
          title="Recent"
          emptyText="No resolved or dismissed insights match the filters."
          items={inactiveItems}
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
  { value: "create_edit", label: "Create/edit" },
  { value: "stuck_turn", label: "Stuck turns" },
  { value: "tool_failure", label: "Tools" },
  { value: "abandoned_goal", label: "Goals" },
  { value: "user_correction", label: "Corrections" },
  { value: "unresolved_conversation", label: "Unresolved" },
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

function SegmentedFilter<T extends string>({
  label,
  hideLabel = false,
  options,
  value,
  onChange,
}: {
  label: string;
  hideLabel?: boolean;
  options: Array<{ value: T; label: string }>;
  value: T;
  onChange: (value: T) => void;
}) {
  return (
    <div className="insights-filter-group">
      {hideLabel ? null : <span>{label}</span>}
      <div className="insights-segmented" role="group" aria-label={label}>
        {options.map((option) => (
          <button
            type="button"
            key={option.value}
            className={option.value === value ? "active" : ""}
            aria-pressed={option.value === value}
            onClick={() => onChange(option.value)}
          >
            {option.label}
          </button>
        ))}
      </div>
    </div>
  );
}

function InsightRows({
  title,
  emptyText,
  items,
  onPatchStatus,
  onOpenSession,
}: {
  title: string;
  emptyText: string;
  items: InsightItem[];
  onPatchStatus: (insightId: string, status: InsightStatus) => Promise<unknown>;
  onOpenSession: (sessionId: string) => void;
}) {
  return (
    <section className="insights-section">
      <h2>{title}</h2>
      {items.length === 0 ? (
        <p className="insights-empty">{emptyText}</p>
      ) : (
        <div className="insights-table" role="table">
          <div className="insights-row insights-run-row insights-row-header" role="row">
            <span role="columnheader">Severity</span>
            <span role="columnheader">Status</span>
            <span role="columnheader">Insight</span>
            <span role="columnheader">Updated</span>
            <span role="columnheader">Actions</span>
          </div>
          {items.map((item) => (
            <div className="insights-row" role="row" key={item.id}>
              <span role="cell">
                <span className={`insights-severity ${item.severity}`}>
                  {severityLabel(item.severity)}
                </span>
              </span>
              <span role="cell" className="insights-status">
                {item.status}
              </span>
              <span role="cell" className="insights-copy">
                <strong>{item.title}</strong>
                <span>{item.summary}</span>
                <small>{sourceLabel(item)}</small>
              </span>
              <span role="cell" className="insights-time">
                {formatTimestamp(item.updatedAt)}
              </span>
              <span role="cell" className="insights-actions">
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
                  <button
                    type="button"
                    className="insights-text-action"
                    onClick={() => onOpenSession(item.lastRunSessionId!)}
                  >
                    Run
                  </button>
                ) : null}
                {item.status === "active" ? (
                  <>
                    <button
                      type="button"
                      title="Resolve insight"
                      aria-label="Resolve insight"
                      onClick={() => void onPatchStatus(item.id, "resolved")}
                    >
                      <CheckCircle2 size={15} />
                    </button>
                    <button
                      type="button"
                      title="Dismiss insight"
                      aria-label="Dismiss insight"
                      onClick={() => void onPatchStatus(item.id, "dismissed")}
                    >
                      <X size={15} />
                    </button>
                  </>
                ) : (
                  <button
                    type="button"
                    title="Reopen insight"
                    aria-label="Reopen insight"
                    onClick={() => void onPatchStatus(item.id, "active")}
                  >
                    <RefreshCw size={15} />
                  </button>
                )}
              </span>
            </div>
          ))}
        </div>
      )}
    </section>
  );
}

function InsightRuns({
  runs,
  onOpenSession,
}: {
  runs: InsightRun[];
  onOpenSession: (sessionId: string) => void;
}) {
  return (
    <section className="insights-section">
      <h2>Runs</h2>
      {runs.length === 0 ? (
        <p className="insights-empty">No Insights runs yet.</p>
      ) : (
        <div className="insights-table insights-runs-table" role="table">
          <div className="insights-row insights-row-header" role="row">
            <span role="columnheader">Trigger</span>
            <span role="columnheader">Status</span>
            <span role="columnheader">Model</span>
            <span role="columnheader">Summary</span>
            <span role="columnheader">Completed</span>
            <span role="columnheader">Actions</span>
          </div>
          {runs.map((run) => (
            <div className="insights-row insights-run-row" role="row" key={run.turnId}>
              <span role="cell">{triggerLabel(run.trigger)}</span>
              <span role="cell" className="insights-status">{run.status}</span>
              <span role="cell" className="insights-status">{runModelLabel(run)}</span>
              <span role="cell" className="insights-copy">
                <strong>{run.summary ?? `${run.findingCount} finding${run.findingCount === 1 ? "" : "s"}`}</strong>
                <span>
                  {run.createdCount} new / {run.updatedCount} updated / {run.resolvedCount} resolved
                </span>
              </span>
              <span role="cell" className="insights-time">
                {formatTimestamp(run.completedAt ?? run.startedAt)}
              </span>
              <span role="cell" className="insights-actions">
                <button type="button" className="insights-text-action" onClick={() => onOpenSession(run.sessionId)}>
                  Open run
                </button>
              </span>
            </div>
          ))}
        </div>
      )}
    </section>
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

function sourceLabel(item: InsightItem): string {
  const parts = [
    evidenceSourceLabel(itemEvidenceSource(item)),
    typeof item.payload.createPipelineOperation === "string" ? item.payload.createPipelineOperation : null,
    typeof item.payload.createPipelineState === "string" ? item.payload.createPipelineState : null,
    typeof item.payload.sessionId === "string" ? item.payload.sessionId : null,
  ].filter(Boolean);
  return parts.join(" / ");
}

function itemEvidenceSource(item: InsightItem): InsightEvidenceSource {
  const value = item.payload.evidenceSource;
  if (
    value === "create_edit" ||
    value === "stuck_turn" ||
    value === "tool_failure" ||
    value === "abandoned_goal" ||
    value === "user_correction" ||
    value === "unresolved_conversation"
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
  return "Create/edit";
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
