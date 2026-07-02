import { useEffect, useRef, useState } from "react";
import type { SettingsSection } from "../../lib/app-models";

const DIAGNOSTICS_ACTION_TIMEOUT_MS = 15000;
const DIAGNOSTICS_LOG_INITIAL_LINES = 100;
const DIAGNOSTICS_LOG_PAGE_LINES = 100;
const DIAGNOSTICS_LOG_TAIL_INTERVAL_MS = 2500;

type DiagnosticsStatus = {
  label: string;
  value: string;
  warning?: boolean;
} | null;

export function useDiagnosticsSettings({
  onError,
  section,
}: {
  onError: (message: string | null) => void;
  section: SettingsSection;
}) {
  const [diagnosticsBusy, setDiagnosticsBusy] = useState<"logs" | "copy" | "export" | null>(null);
  const [logViewBusy, setLogViewBusy] = useState<"refresh" | "older" | null>(null);
  const [logLineLimit, setLogLineLimit] = useState(DIAGNOSTICS_LOG_INITIAL_LINES);
  const [logLines, setLogLines] = useState<OpenPondLogLine[]>([]);
  const [logDir, setLogDir] = useState<string | null>(null);
  const [tailLogs, setTailLogs] = useState(true);
  const logViewportRef = useRef<HTMLDivElement | null>(null);
  const [diagnosticsStatus, setDiagnosticsStatus] = useState<DiagnosticsStatus>(null);
  const diagnosticsAvailable = Boolean(
    window.openpond?.openLogsFolder ||
      window.openpond?.readRecentLogs ||
      window.openpond?.copyRecentLogs ||
      window.openpond?.exportDiagnostics
  );
  const logViewAvailable = Boolean(window.openpond?.readRecentLogs);
  const logViewSummary = logViewAvailable
    ? `${logLines.length} of ${logLineLimit} line${logLineLimit === 1 ? "" : "s"}${tailLogs ? " tailing" : ""}`
    : "Unavailable";

  useEffect(() => {
    if (section !== "diagnostics") return;
    void refreshLogView(logLineLimit, "refresh", { quiet: true });
  }, [section]);

  useEffect(() => {
    if (section !== "diagnostics" || !tailLogs || !window.openpond?.readRecentLogs) return;
    let inFlight = false;
    const timer = window.setInterval(() => {
      if (inFlight) return;
      inFlight = true;
      void refreshLogView(logLineLimit, "refresh", { quiet: true }).finally(() => {
        inFlight = false;
      });
    }, DIAGNOSTICS_LOG_TAIL_INTERVAL_MS);
    return () => window.clearInterval(timer);
  }, [section, tailLogs, logLineLimit]);

  useEffect(() => {
    if (section !== "diagnostics" || !tailLogs) return;
    const node = logViewportRef.current;
    if (node) node.scrollTop = node.scrollHeight;
  }, [section, tailLogs, logLines]);

  async function refreshLogView(
    nextLineLimit = logLineLimit,
    mode: "refresh" | "older" = "refresh",
    options: { quiet?: boolean } = {}
  ) {
    const readLogs = window.openpond?.readRecentLogs;
    if (!readLogs) {
      const message = "Log view is not available in this runtime.";
      if (!options.quiet) {
        setDiagnosticsStatus({ label: "Logs", value: message, warning: true });
        onError(message);
      }
      return;
    }
    if (!options.quiet) setLogViewBusy(mode);
    try {
      const result = await withDiagnosticsTimeout(readLogs(nextLineLimit), "Read logs");
      if (!result.ok) throw new Error(result.error);
      setLogLineLimit(result.lineLimit);
      setLogDir(result.logDir);
      setLogLines(result.lines);
      if (options.quiet) {
        setDiagnosticsStatus((current) => (current?.label === "Logs" ? null : current));
      } else {
        setDiagnosticsStatus(null);
      }
    } catch (diagnosticsError) {
      const message = diagnosticsError instanceof Error ? diagnosticsError.message : String(diagnosticsError);
      setDiagnosticsStatus({ label: "Logs", value: message, warning: true });
      if (!options.quiet) onError(message);
    } finally {
      if (!options.quiet) setLogViewBusy(null);
    }
  }

  function loadOlderLogs() {
    setTailLogs(false);
    void refreshLogView(logLineLimit + DIAGNOSTICS_LOG_PAGE_LINES, "older");
  }

  function toggleTailLogs() {
    const nextTail = !tailLogs;
    setTailLogs(nextTail);
    if (nextTail) void refreshLogView(logLineLimit, "refresh", { quiet: true });
  }

  async function openLogsFolder() {
    const openLogs = window.openpond?.openLogsFolder;
    if (!openLogs) {
      const message = "Desktop logs are not available in this runtime.";
      setDiagnosticsStatus({ label: "Logs", value: message, warning: true });
      onError(message);
      return;
    }
    setDiagnosticsBusy("logs");
    onError(null);
    try {
      const result = await withDiagnosticsTimeout(openLogs(), "Open logs");
      if (!result.ok) throw new Error(result.error ?? "Could not open the logs folder.");
      setDiagnosticsStatus(null);
    } catch (diagnosticsError) {
      const message = diagnosticsError instanceof Error ? diagnosticsError.message : String(diagnosticsError);
      setDiagnosticsStatus({ label: "Logs", value: message, warning: true });
      onError(message);
    } finally {
      setDiagnosticsBusy(null);
    }
  }

  async function copyRecentLogs() {
    const copyLogs = window.openpond?.copyRecentLogs;
    if (!copyLogs) {
      const message = "Recent log copy is not available in this runtime.";
      setDiagnosticsStatus({ label: "Copy", value: message, warning: true });
      onError(message);
      return;
    }
    setDiagnosticsBusy("copy");
    onError(null);
    try {
      const result = await withDiagnosticsTimeout(copyLogs(1000), "Copy recent logs");
      if (!result.ok) throw new Error(result.error ?? "Could not copy recent logs.");
      setDiagnosticsStatus({
        label: "Copy",
        value: result.lines ? `Copied ${result.lines} recent log lines.` : "Copied recent logs.",
      });
    } catch (diagnosticsError) {
      const message = diagnosticsError instanceof Error ? diagnosticsError.message : String(diagnosticsError);
      setDiagnosticsStatus({ label: "Copy", value: message, warning: true });
      onError(message);
    } finally {
      setDiagnosticsBusy(null);
    }
  }

  async function exportDiagnosticsBundle() {
    const exportDiagnostics = window.openpond?.exportDiagnostics;
    if (!exportDiagnostics) {
      const message = "Diagnostics export is not available in this runtime.";
      setDiagnosticsStatus({ label: "Export", value: message, warning: true });
      onError(message);
      return;
    }
    setDiagnosticsBusy("export");
    onError(null);
    try {
      const result = await withDiagnosticsTimeout(exportDiagnostics(), "Export diagnostics");
      if (!result.ok) throw new Error(result.error ?? "Could not export diagnostics.");
      setDiagnosticsStatus({
        label: "Export",
        value: result.path ? `Saved to ${result.path}` : "Diagnostics exported.",
      });
    } catch (diagnosticsError) {
      const message = diagnosticsError instanceof Error ? diagnosticsError.message : String(diagnosticsError);
      setDiagnosticsStatus({ label: "Export", value: message, warning: true });
      onError(message);
    } finally {
      setDiagnosticsBusy(null);
    }
  }

  return {
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
  };
}

async function withDiagnosticsTimeout<T>(operation: Promise<T>, label: string): Promise<T> {
  let timeout: number | undefined;
  try {
    return await Promise.race([
      operation,
      new Promise<never>((_resolve, reject) => {
        timeout = window.setTimeout(() => {
          reject(new Error(`${label} did not receive a desktop response.`));
        }, DIAGNOSTICS_ACTION_TIMEOUT_MS);
      }),
    ]);
  } finally {
    if (timeout !== undefined) window.clearTimeout(timeout);
  }
}
