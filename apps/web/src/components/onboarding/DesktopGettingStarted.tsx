import { lazy, Suspense, useEffect, useState } from "react";
import type { BootstrapPayload } from "@openpond/contracts";
import type { ClientConnection } from "../../api";
import { isDesktopShell } from "../app-shell/WindowControls";
import { ONBOARDING_STORAGE_KEY, OPEN_ONBOARDING_EVENT, scheduleGettingStarted } from "./onboarding-lifecycle";

const GettingStartedDialog = lazy(() => import("./GettingStartedDialog").then(module => ({ default: module.GettingStartedDialog })));

export function DesktopGettingStarted({ ready, connection, payload, onPayload }: {
  ready: boolean;
  connection: ClientConnection | null;
  payload: BootstrapPayload | null;
  onPayload: (payload: BootstrapPayload) => void;
}) {
  const [open, setOpen] = useState(false);
  const [dismissed, setDismissed] = useState(() => {
    try { return localStorage.getItem(ONBOARDING_STORAGE_KEY) !== null; }
    catch { return false; }
  });
  const desktop = isDesktopShell();
  const accountSettled = payload?.account.state === "signed_in" || payload?.account.state === "signed_out" || payload?.account.state === "auth_error";
  const complete = payload?.account.state === "signed_in"
    && Boolean(payload.providers.providers.codex?.enabled && payload.providers.statuses.codex?.available)
    && Boolean(payload.providers.providers["claude-code"]?.enabled && payload.providers.statuses["claude-code"]?.available);

  useEffect(() => {
    if (!desktop || !ready || !connection || !accountSettled || dismissed || complete || open) return;
    return scheduleGettingStarted(() => setOpen(true), () => {
      const focused = document.activeElement;
      return document.hidden || Boolean(document.querySelector('[role="dialog"]'))
        || (focused instanceof HTMLElement && (focused.isContentEditable || focused.matches("input, textarea")));
    });
  }, [desktop, ready, connection?.serverUrl, connection?.token, accountSettled, dismissed, complete, open]);

  useEffect(() => {
    function reopen() { if (ready && connection) setOpen(true); }
    window.addEventListener(OPEN_ONBOARDING_EVENT, reopen);
    return () => window.removeEventListener(OPEN_ONBOARDING_EVENT, reopen);
  }, [ready, connection]);

  function close() {
    setOpen(false);
    setDismissed(true);
    try { localStorage.setItem(ONBOARDING_STORAGE_KEY, "dismissed"); }
    catch { /* Remember dismissal for this launch when storage is unavailable. */ }
  }

  if (!open || !ready || !connection || !payload) return null;
  return <Suspense fallback={null}>
    <GettingStartedDialog key={JSON.stringify([connection.serverUrl, connection.token])} connection={connection} payload={payload} onPayload={onPayload} onClose={close} />
  </Suspense>;
}
