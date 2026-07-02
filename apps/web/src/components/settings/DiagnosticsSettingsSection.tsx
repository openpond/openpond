import type { RefObject } from "react";
import { ChevronUp, ClipboardCopy, Download, FolderOpen, Pause, Play, RefreshCw } from "../icons";

type DiagnosticsStatus = {
  label: string;
  value: string;
  warning?: boolean;
} | null;

type DiagnosticsSettingsSectionProps = {
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
  return (
    <section className="account-settings">
      <h1>Diagnostics</h1>
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
            disabled={diagnosticsBusy !== null || !window.openpond?.openLogsFolder}
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
            disabled={diagnosticsBusy !== null || !window.openpond?.exportDiagnostics}
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
            disabled={diagnosticsBusy !== null || !window.openpond?.copyRecentLogs}
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
              disabled={!window.openpond?.readRecentLogs}
              onClick={toggleTailLogs}
            >
              {tailLogs ? <Pause size={15} /> : <Play size={15} />}
            </button>
            <button
              type="button"
              className="settings-icon-button"
              title="Refresh logs"
              aria-label="Refresh logs"
              disabled={logViewBusy !== null || !window.openpond?.readRecentLogs}
              onClick={() => void refreshLogView(logLineLimit, "refresh")}
            >
              <RefreshCw size={15} />
            </button>
            <button
              type="button"
              className="settings-secondary"
              disabled={logViewBusy !== null || !window.openpond?.readRecentLogs}
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
