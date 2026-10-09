import { useState } from "react";
import { Download, Loader2, RefreshCw } from "../icons";
import { useDesktopUpdates } from "../../hooks/useDesktopUpdates";
import { clearDesktopUpdateDrafts } from "../../lib/desktop-update-drafts";

export function DesktopUpdateButton({ hasRunningWork }: { hasRunningWork: boolean }) {
  const state = useDesktopUpdates();
  const [pending, setPending] = useState(false);
  const [requestError, setRequestError] = useState<string | null>(null);
  const bridge = window.openpond?.updates;
  if (!state?.version || state.status === "unsupported" || !bridge) return null;
  const ready = state.status === "ready" || state.status === "restarting" || state.retry === "restart";
  const busy = pending || state.status === "downloading" || state.status === "restarting" || state.status === "checking";
  const error = requestError ?? state.error;
  const label = ready ? "Restart to update" : "Update";
  const description = error ?? (busy
    ? ready ? "Restarting OpenPond…" : `Downloading OpenPond ${state.version}${state.progress === null ? "" : ` (${state.progress}%)`}…`
    : ready ? `OpenPond ${state.version} is ready. It will be applied when you restart.`
      : `Download OpenPond ${state.version}`);

  async function activate() {
    if (busy || !bridge) return;
    setPending(true);
    setRequestError(null);
    try {
      if (ready) {
        // Draft persistence listeners can stop the restart if saving fails.
        if (!window.dispatchEvent(new Event("openpond:before-update", { cancelable: true }))) {
          throw new Error("Could not save your drafts. Save them before restarting to update.");
        }
        const result = await bridge.restartAndInstall({ hasRunningWork });
        // A canceled or failed restart keeps this renderer alive. Discard the
        // snapshot so a later ordinary launch cannot restore stale drafts.
        if (result.status !== "restarting") clearDesktopUpdateDrafts();
      } else if (state?.retry === "check") {
        await bridge.check();
      } else {
        await bridge.download();
      }
    } catch (error) {
      setRequestError(error instanceof Error ? error.message : "The update could not start. Try again.");
    } finally {
      setPending(false);
    }
  }

  return <div className="sidebar-update-control">
    <button type="button" className="sidebar-update-pill" title={description}
      aria-label={busy ? description : `${label}${state.version ? ` (${state.version})` : ""}`}
      aria-busy={busy} disabled={busy} onClick={() => void activate()}>
      <span className={`sidebar-update-icon${busy ? " sidebar-update-spinner" : ""}`} aria-hidden="true">
        {busy ? <Loader2 size={14} /> : ready ? <RefreshCw size={14} /> : <Download size={14} />}
      </span>
      <span>{label}</span>
    </button>
    <span className="sr-only" role="status" aria-live="polite">
      {state.status === "ready" ? `OpenPond ${state.version} is ready to install. Restart to update.` : ""}
    </span>
    {error ? <div className="sidebar-update-error" role="alert">{error}</div> : null}
  </div>;
}
