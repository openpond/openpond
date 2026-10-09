import { Download, Loader2, RefreshCw } from "../icons";
import { useDesktopUpdateAction } from "../../hooks/useDesktopUpdateAction";

export function DesktopUpdateButton({ hasRunningWork }: { hasRunningWork: boolean }) {
  const { state, busy, error, run } = useDesktopUpdateAction(hasRunningWork);
  const bridge = window.openpond?.updates;
  const retryCheck = state?.status === "error" && state.retry === "check";
  if (!state || (!state.version && !retryCheck) || state.status === "unsupported" || !bridge) return null;
  const ready = state.status === "ready" || state.status === "restarting" || state.retry === "restart";
  const label = retryCheck ? "Retry update check" : ready ? "Restart to update" : "Update";
  const description = error ?? (state.status === "checking" ? "Checking for updates…" : busy
    ? ready ? "Restarting OpenPond…" : `Downloading OpenPond ${state.version}${state.progress === null ? "" : ` (${state.progress}%)`}…`
    : ready ? `OpenPond ${state.version} is ready. It will be applied when you restart.`
      : `Download OpenPond ${state.version}`);

  return <div className="sidebar-update-control">
    <button type="button" className="sidebar-update-pill" title={description}
      aria-label={busy ? description : `${label}${state.version ? ` (${state.version})` : ""}`}
      aria-busy={busy} disabled={busy} onClick={() => void run(ready ? "restart" : state.retry === "check" ? "check" : "download")}>
      <span className={`sidebar-update-icon${busy ? " sidebar-update-spinner" : ""}`} aria-hidden="true">
        {busy ? <Loader2 size={14} /> : ready || retryCheck ? <RefreshCw size={14} /> : <Download size={14} />}
      </span>
      <span>{label}</span>
    </button>
    <span className="sr-only" role="status" aria-live="polite">
      {state.status === "ready" ? `OpenPond ${state.version} is ready to install. Restart to update.` : ""}
    </span>
    {error ? <div className="sidebar-update-error" role="alert">{error}</div> : null}
  </div>;
}
