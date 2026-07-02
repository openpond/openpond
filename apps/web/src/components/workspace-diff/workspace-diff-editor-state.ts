import type {
  WorkspaceLspDiagnostic,
  WorkspaceLspServerStatus,
} from "@openpond/contracts";
import type { EditorDiagnosticStatus } from "./WorkspaceDiffPanelChrome";

const EDITOR_CONTROLS_STORAGE_KEY = "openpond.workspace.editorControlsVisible";

export function readEditorControlsVisible(): boolean {
  try {
    return window.localStorage.getItem(EDITOR_CONTROLS_STORAGE_KEY) === "true";
  } catch {
    return false;
  }
}

export function writeEditorControlsVisible(value: boolean): void {
  try {
    window.localStorage.setItem(EDITOR_CONTROLS_STORAGE_KEY, String(value));
  } catch {
    // Storage can be unavailable in restricted browser contexts.
  }
}

export function editorDiagnosticStatus({
  activeDiagnostics,
  activeServers,
  editorDiagnosticsChecking,
  editorLspEnabled,
  showEditorCommandBar,
}: {
  activeDiagnostics: WorkspaceLspDiagnostic[];
  activeServers: WorkspaceLspServerStatus[] | null;
  editorDiagnosticsChecking: boolean;
  editorLspEnabled: boolean;
  showEditorCommandBar: boolean;
}): EditorDiagnosticStatus | null {
  if (!showEditorCommandBar) return null;
  if (!editorLspEnabled) return { label: "LSP off", severity: "unavailable" };
  if (editorDiagnosticsChecking) return { label: "Checking", severity: "info" };
  const errorCount = activeDiagnostics.filter((diagnostic) => diagnostic.severity === "error").length;
  if (errorCount > 0) return { label: `${errorCount} error${errorCount === 1 ? "" : "s"}`, severity: "error" };
  const warningCount = activeDiagnostics.filter((diagnostic) => diagnostic.severity === "warning").length;
  if (warningCount > 0) return { label: `${warningCount} warning${warningCount === 1 ? "" : "s"}`, severity: "warning" };
  const noteCount = activeDiagnostics.length;
  if (noteCount > 0) return { label: `${noteCount} note${noteCount === 1 ? "" : "s"}`, severity: "info" };
  if (!activeServers) return null;
  const serverProblem = activeServers.find((server) => server.status !== "connected");
  if (serverProblem) {
    return {
      label: serverProblem.id === "none" ? "No LSP" : `${serverProblem.id} unavailable`,
      severity: "unavailable",
    };
  }
  return { label: "No issues", severity: "none" };
}
