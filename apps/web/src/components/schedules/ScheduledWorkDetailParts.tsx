import type {
  HostedSavedWorkRun,
  LocalAgentScheduleRun,
} from "@openpond/contracts";
import type {
  PointerEvent as ReactPointerEvent,
  ReactNode,
} from "react";
import {
  CalendarClock,
  ExternalLink,
  Loader2,
  Maximize2,
  Minimize2,
  X,
} from "../icons";
import {
  capitalize,
  formatScheduledRunAt,
  runStatusLabel,
} from "./scheduledWorkFormatting";

export function LocalScheduleRunRow({ run }: { run: LocalAgentScheduleRun }) {
  const output = run.error || run.stderr || run.stdout;
  return (
    <details className="scheduled-run-row">
      <summary>
        <span>
          <strong>{runStatusLabel(run.status)}</strong>
          <small>{formatScheduledRunAt(run.createdAt, null)}</small>
        </span>
        <span className="scheduled-run-trigger">
          {run.trigger === "manual" ? "Manual" : "Scheduled"}
        </span>
      </summary>
      {output ? <pre>{output}</pre> : null}
    </details>
  );
}

export function ScheduleRunRow({
  onOpen,
  run,
}: {
  onOpen: () => void;
  run: HostedSavedWorkRun;
}) {
  return (
    <button className="scheduled-run-row hosted" onClick={onOpen} type="button">
      <span>
        <strong>{runStatusLabel(run.status)}</strong>
        <small>{formatScheduledRunAt(run.createdAt, null)}</small>
      </span>
      <span className="scheduled-run-trigger">
        {capitalize(run.triggerKind)} <ExternalLink size={11} />
      </span>
      {run.deliveryError ? <p>{run.deliveryError}</p> : null}
    </button>
  );
}

export function ScheduleDetailPanel({
  children,
  detailExpanded,
  label,
  onClose,
  onDetailResizeStart,
  onToggleDetailExpanded,
}: {
  children: ReactNode;
  detailExpanded: boolean;
  label: string;
  onClose: () => void;
  onDetailResizeStart: (event: ReactPointerEvent<HTMLDivElement>) => void;
  onToggleDetailExpanded: () => void;
}) {
  return (
    <aside
      aria-label={label}
      className={`workspace-diff-panel scheduled-detail${detailExpanded ? " expanded" : ""}`}
    >
      {!detailExpanded ? (
        <div
          aria-label="Resize schedule details"
          aria-orientation="vertical"
          className="workspace-diff-resize-handle"
          onPointerDown={onDetailResizeStart}
          role="separator"
        />
      ) : null}
      <div className="workspace-diff-topbar">
        <div className="workspace-diff-tabs" role="tablist" aria-label="Schedule details">
          <button
            aria-selected="true"
            className="workspace-diff-tab active"
            role="tab"
            type="button"
          >
            <CalendarClock size={14} />
            <span>Schedule</span>
          </button>
        </div>
        <div className="workspace-diff-toolbar-actions">
          <button
            aria-label={detailExpanded ? "Dock schedule details" : "Expand schedule details"}
            className="diff-icon-button"
            onClick={onToggleDetailExpanded}
            title={detailExpanded ? "Dock schedule details" : "Expand schedule details"}
            type="button"
          >
            {detailExpanded ? <Minimize2 size={14} /> : <Maximize2 size={14} />}
          </button>
          <button
            aria-label="Close schedule details"
            className="diff-icon-button"
            onClick={onClose}
            title="Close schedule details"
            type="button"
          >
            <X size={14} />
          </button>
        </div>
      </div>
      <div className="scheduled-detail-body">{children}</div>
    </aside>
  );
}

export function DetailSection({ children, title }: { children: ReactNode; title: string }) {
  return (
    <section className="scheduled-detail-section">
      <div className="scheduled-detail-section-heading">
        <h3>{title}</h3>
      </div>
      {children}
    </section>
  );
}

export function DetailField({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <dt>{label}</dt>
      <dd>{value}</dd>
    </div>
  );
}

export function EmptyMessage({ children }: { children: ReactNode }) {
  return <p className="scheduled-empty">{children}</p>;
}

export function LoadingMessage({ label }: { label: string }) {
  return (
    <div className="scheduled-loading" role="status">
      <Loader2 className="scheduled-spin" size={16} />
      <span>{label}</span>
    </div>
  );
}
