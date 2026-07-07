import type { RefObject } from "react";
import type { RuntimeEvent } from "@openpond/contracts";
import { ChevronUp, CircleAlert, ClipboardCopy, Download, FolderOpen, Pause, Play, RefreshCw } from "../icons";

type DiagnosticsStatus = {
  label: string;
  value: string;
  warning?: boolean;
} | null;

type DiagnosticsSettingsSectionProps = {
  diagnostics: RuntimeEvent[];
  diagnosticsAvailable: boolean;
  diagnosticsBusy: "logs" | "copy" | "export" | null;
  diagnosticsStatus: DiagnosticsStatus;
  logDir: string | null;
  logLineLimit: number;
  logLines: OpenPondLogLine[];
  logViewBusy: "refresh" | "older" | null;
  logViewSummary: string;
  logViewportRef: RefObject<HTMLDivElement | null>;
  tailLogs: boolean;
  copyRecentLogs: () => Promise<void>;
  exportDiagnosticsBundle: () => Promise<void>;
  loadOlderLogs: () => void;
  openLogsFolder: () => Promise<void>;
  refreshLogView: (nextLineLimit?: number, mode?: "refresh" | "older", options?: { quiet?: boolean }) => Promise<void>;
  toggleTailLogs: () => void;
};

export function DiagnosticsSettingsSection({
  diagnostics,
  diagnosticsAvailable,
  diagnosticsBusy,
  diagnosticsStatus,
  logDir,
  logLineLimit,
  logLines,
  logViewBusy,
  logViewSummary,
  logViewportRef,
  tailLogs,
  copyRecentLogs,
  exportDiagnosticsBundle,
  loadOlderLogs,
  openLogsFolder,
  refreshLogView,
  toggleTailLogs,
}: DiagnosticsSettingsSectionProps) {
  const savedDiagnostics = diagnostics
    .filter((diagnostic) => diagnostic.name === "diagnostic" && diagnostic.status === "failed")
    .slice()
    .reverse()
    .map(formatSavedDiagnostic);
  const openpond = typeof window === "undefined" ? undefined : window.openpond;
  return (
    <section className="account-settings">
      <h1>Diagnostics</h1>
      <div className="diagnostics-log-panel">
        <div className="account-list-heading">
          <span>Recent errors</span>
          <small>{savedDiagnostics.length} saved</small>
        </div>
        <div className="diagnostics-error-list" role="list">
          {savedDiagnostics.length === 0 ? (
            <div className="diagnostics-error-empty">No saved errors</div>
          ) : (
            savedDiagnostics.map((diagnostic) => (
              <article className="diagnostics-error-entry" key={diagnostic.id} role="listitem">
                <CircleAlert size={15} />
                <div className="diagnostics-error-body">
                  <div className="diagnostics-error-title">
                    <strong>{diagnostic.message}</strong>
                    <time dateTime={diagnostic.timestamp}>{diagnostic.timeLabel}</time>
                  </div>
                  <div className="diagnostics-error-meta">
                    <span>{diagnostic.surface}</span>
                    {diagnostic.status ? <span>{diagnostic.status}</span> : null}
                    {diagnostic.sequence ? <span>#{diagnostic.sequence}</span> : null}
                  </div>
                  {diagnostic.detail ? (
                    <details className="diagnostics-error-detail">
                      <summary>Details</summary>
                      <pre>{diagnostic.detail}</pre>
                    </details>
                  ) : null}
                </div>
              </article>
            ))
          )}
        </div>
      </div>
      <div className="account-list">
        <div className="account-list-heading">
          <span>Logs</span>
          <small>{diagnosticsAvailable ? "Desktop" : "Unavailable"}</small>
        </div>
        <div className="product-row">
          <div>
            <strong>Logs folder</strong>
            <span>Desktop and server logs</span>
          </div>
          <button
            type="button"
            className="settings-secondary"
            disabled={diagnosticsBusy !== null || !openpond?.openLogsFolder}
            onClick={() => void openLogsFolder()}
          >
            <FolderOpen size={15} />
            <span>{diagnosticsBusy === "logs" ? "Opening" : "Open"}</span>
          </button>
        </div>
        <div className="product-row">
          <div>
            <strong>Diagnostics export</strong>
            <span>Support folder with diagnostics.txt</span>
          </div>
          <button
            type="button"
            className="settings-secondary"
            disabled={diagnosticsBusy !== null || !openpond?.exportDiagnostics}
            onClick={() => void exportDiagnosticsBundle()}
          >
            <Download size={15} />
            <span>{diagnosticsBusy === "export" ? "Exporting" : "Export"}</span>
          </button>
        </div>
        <div className="product-row">
          <div>
            <strong>Recent logs</strong>
            <span>Last 1000 lines to clipboard</span>
          </div>
          <button
            type="button"
            className="settings-secondary"
            disabled={diagnosticsBusy !== null || !openpond?.copyRecentLogs}
            onClick={() => void copyRecentLogs()}
          >
            <ClipboardCopy size={15} />
            <span>{diagnosticsBusy === "copy" ? "Copying" : "Copy"}</span>
          </button>
        </div>
      </div>

      <div className="diagnostics-log-panel">
        <div className="account-list-heading">
          <span>Log view</span>
          <div className="settings-heading-actions diagnostics-log-actions">
            <small>{logViewSummary}</small>
            <button
              type="button"
              className={`settings-icon-button ${tailLogs ? "active" : ""}`}
              title={tailLogs ? "Pause tail" : "Tail logs"}
              aria-label={tailLogs ? "Pause tail" : "Tail logs"}
              disabled={!openpond?.readRecentLogs}
              onClick={toggleTailLogs}
            >
              {tailLogs ? <Pause size={15} /> : <Play size={15} />}
            </button>
            <button
              type="button"
              className="settings-icon-button"
              title="Refresh logs"
              aria-label="Refresh logs"
              disabled={logViewBusy !== null || !openpond?.readRecentLogs}
              onClick={() => void refreshLogView(logLineLimit, "refresh")}
            >
              <RefreshCw size={15} />
            </button>
            <button
              type="button"
              className="settings-secondary"
              disabled={logViewBusy !== null || !openpond?.readRecentLogs}
              onClick={loadOlderLogs}
            >
              <ChevronUp size={15} />
              <span>{logViewBusy === "older" ? "Loading" : "Older"}</span>
            </button>
          </div>
        </div>
        <div ref={logViewportRef} className="diagnostics-log-viewer" role="log" aria-live={tailLogs ? "polite" : "off"}>
          {logLines.length === 0 ? (
            <div className="diagnostics-log-empty">{logViewBusy ? "Loading logs" : "No log lines"}</div>
          ) : (
            logLines.map((entry, index) => (
              <div className="diagnostics-log-entry" key={`${entry.file}:${entry.timestamp}:${entry.index}:${index}`}>
                <span className="diagnostics-log-source">{entry.file}</span>
                <code>{entry.line}</code>
              </div>
            ))
          )}
        </div>
        {logDir && (
          <div className="diagnostics-log-dir">
            <span>Source</span>
            <strong>{logDir}</strong>
          </div>
        )}
      </div>

      {diagnosticsStatus && (
        <div className={`settings-footnote ${diagnosticsStatus.warning ? "warning" : ""}`}>
          <span>{diagnosticsStatus.label}</span>
          <strong>{diagnosticsStatus.value}</strong>
        </div>
      )}
    </section>
  );
}

type SavedDiagnostic = {
  id: string;
  timestamp: string;
  timeLabel: string;
  message: string;
  surface: string;
  status: string | null;
  sequence: number | null;
  detail: string | null;
};

function formatSavedDiagnostic(event: RuntimeEvent): SavedDiagnostic {
  const data = asRecord(event.data);
  const context = asRecord(data.context);
  const stack = stringValue(data.stack);
  const detail = stack ?? stringValue(data.detail) ?? stringValue(context.detail) ?? null;
  return {
    id: event.id,
    timestamp: event.timestamp,
    timeLabel: formatDiagnosticTime(event.timestamp),
    message: diagnosticMessage(event, data),
    surface: stringValue(data.surface) ?? event.source ?? "diagnostic",
    status: event.status ?? null,
    sequence: event.sequence ?? null,
    detail,
  };
}

function diagnosticMessage(event: RuntimeEvent, data: Record<string, unknown>): string {
  return (
    stringValue(event.error) ??
    stringValue(event.output) ??
    stringValue(data.message) ??
    stringValue(data.error) ??
    "Diagnostic event"
  );
}

function formatDiagnosticTime(timestamp: string): string {
  const date = new Date(timestamp);
  if (Number.isNaN(date.getTime())) return timestamp;
  return date.toLocaleString([], {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function stringValue(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}
