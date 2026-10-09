import { useState } from "react";
import { Loader2, RefreshCw } from "../icons";
import { useDesktopUpdateAction } from "../../hooks/useDesktopUpdateAction";

export function DesktopUpdateMenu({ hasRunningWork }: { hasRunningWork: boolean }) {
  const { state, busy, pendingAction, error, run } = useDesktopUpdateAction(hasRunningWork);
  const [checked, setChecked] = useState(false);
  const bridge = window.openpond?.updates;
  if (!state || state.status === "unsupported" || !bridge) return null;
  const ready = state.status === "ready" || state.status === "restarting" || state.retry === "restart";
  const available = state.status === "available" || state.retry === "download";
  const checking = state.status === "checking" || pendingAction === "check";
  const restarting = state.status === "restarting" || pendingAction === "restart";
  const downloading = state.status === "downloading" || pendingAction === "download";
  const action = ready ? "restart" : checked && available ? "download" : "check";
  const status = error ? "Try again" : checking ? "Checking…" : restarting ? "Restarting…"
    : downloading ? `Downloading${state.progress === null ? "…" : ` ${state.progress}%`}`
    : ready ? "Restart to update" : checked && available ? "Update available"
    : checked && state.status === "current" ? "Up to date" : null;
  const description = error ?? (action === "restart" ? "Restart OpenPond to install the downloaded update."
    : action === "download" ? `Download OpenPond ${state.version}.` : "Check for OpenPond updates.");

  async function activate() {
    if (busy || !bridge) return;
    setChecked(true);
    await run(action);
  }

  // A second click on the same row downloads an available update. Keep the
  // result inline and share restart/draft safeguards with the toolbar action.
  return <button type="button" className="user-auth-menu-link user-auth-update-check" role="menuitem"
      title={description} aria-description={description}
      disabled={busy} aria-busy={busy} onClick={() => void activate()}>
      {busy ? <span className="sidebar-update-icon sidebar-update-spinner" aria-hidden="true"><Loader2 size={15} /></span>
        : <RefreshCw size={15} aria-hidden="true" />}
      <span className="user-auth-update-label">Check for updates</span>
      {status ? <span className="user-auth-update-status" role={error ? "alert" : "status"}>{status}</span> : null}
    </button>;
}
