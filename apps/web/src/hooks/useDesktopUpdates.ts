import { useEffect, useState } from "react";
import type { DesktopUpdateState } from "@openpond/contracts";

export function useDesktopUpdates(): DesktopUpdateState | null {
  const [state, setState] = useState<DesktopUpdateState | null>(null);
  useEffect(() => {
    const bridge = window.openpond?.updates;
    if (!bridge) return;
    let active = true;
    const accept = (next: DesktopUpdateState) => {
      if (active) setState((current) => !current || next.revision > current.revision ? next : current);
    };
    // Subscribe before requesting the snapshot; revision ordering prevents an
    // older IPC response from rolling back a newer progress/ready event.
    const unsubscribe = bridge.onState(accept);
    void bridge.getState().then(accept).catch(() => undefined);
    return () => { active = false; unsubscribe(); };
  }, []);
  return state;
}
