import { useState } from "react";
import { Loader2, RefreshCw } from "../icons";
import { useDesktopUpdates } from "../../hooks/useDesktopUpdates";
import { DesktopUpdateButton } from "./DesktopUpdateButton";

export function DesktopUpdateMenu({ hasRunningWork }: { hasRunningWork: boolean }) {
  const state = useDesktopUpdates();
  const [pending, setPending] = useState(false);
  const [requestError, setRequestError] = useState<string | null>(null);
  const bridge = window.openpond?.updates;
  if (!state || state.status === "unsupported" || !bridge) return null;
  const busy = pending || ["checking", "downloading", "restarting"].includes(state.status);
  const error = requestError ?? (state.retry === "check" ? state.error : null);
  const message = error ?? (state.status === "checking" ? "Checking for updates…"
    : state.status === "current" ? `OpenPond ${state.installedVersion} is up to date.`
    : state.status === "available" ? `OpenPond ${state.version} is available.`
    : state.status === "downloading" ? `Downloading OpenPond ${state.version}${state.progress === null ? "" : ` (${state.progress}%)`}…`
    : state.status === "ready" ? `OpenPond ${state.version} is ready to install.`
    : state.status === "restarting" ? "Restarting OpenPond…" : null);

  async function check() {
    if (busy || !bridge) return;
    setPending(true);
    setRequestError(null);
    try {
      await bridge.check();
    } catch (error) {
      setRequestError(error instanceof Error ? error.message : "Could not check for updates. Try again.");
    } finally {
      setPending(false);
    }
  }

  // Keep the menu open so a manual check always has a visible result. Updates
  // share the sidebar action, including draft recovery and running-work checks.
  return <>
    <button type="button" className="user-auth-menu-link" role="menuitem"
      disabled={busy} aria-busy={busy} onClick={() => void check()}>
      {state.status === "checking" || pending ? <span className="sidebar-update-icon sidebar-update-spinner" aria-hidden="true"><Loader2 size={15} /></span>
        : <RefreshCw size={15} aria-hidden="true" />}
      <span>{state.status === "checking" || pending ? "Checking for updates…" : "Check for updates"}</span>
    </button>
    {message ? <p className="user-auth-update-status" role={error ? "alert" : "status"}>{message}</p> : null}
    {state.version && state.retry !== "check" ? <DesktopUpdateButton hasRunningWork={hasRunningWork} placement="menu" /> : null}
  </>;
}
