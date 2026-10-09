import { useState } from "react";
import { useDesktopUpdates } from "./useDesktopUpdates";
import { clearDesktopUpdateDrafts } from "../lib/desktop-update-drafts";

export type DesktopUpdateAction = "check" | "download" | "restart";

export function useDesktopUpdateAction(hasRunningWork: boolean) {
  const state = useDesktopUpdates();
  const [pendingAction, setPendingAction] = useState<DesktopUpdateAction | null>(null);
  const [requestError, setRequestError] = useState<{ revision: number; message: string } | null>(null);
  const bridge = window.openpond?.updates;
  const busy = pendingAction !== null || state?.status === "checking" || state?.status === "downloading" || state?.status === "restarting";
  const error = requestError?.revision === state?.revision ? requestError?.message : state?.error;

  async function run(action: DesktopUpdateAction) {
    if (busy || !bridge || !state) return;
    setPendingAction(action);
    setRequestError(null);
    try {
      if (action === "restart") {
        // Draft persistence listeners can stop the restart if saving fails.
        if (!window.dispatchEvent(new Event("openpond:before-update", { cancelable: true }))) {
          throw new Error("Could not save your drafts. Save them before restarting to update.");
        }
        const result = await bridge.restartAndInstall({ hasRunningWork });
        // A canceled or failed restart keeps this renderer alive. Discard the
        // snapshot so a later ordinary launch cannot restore stale drafts.
        if (result.status !== "restarting") clearDesktopUpdateDrafts();
      } else if (action === "check") {
        await bridge.check();
      } else {
        await bridge.download();
      }
    } catch (error) {
      setRequestError({ revision: state.revision, message: error instanceof Error ? error.message : "The update could not start. Try again." });
    } finally {
      setPendingAction(null);
    }
  }

  return { state, busy, pendingAction, error, run };
}
