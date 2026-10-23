import { useHostedSandboxes } from "./useHostedSandboxes";
import { useEffect, useId, useRef, useState, type CSSProperties } from "react";
import { useQuery } from "@tanstack/react-query";
import type { RemoteAccessSettingsStatus } from "@openpond/contracts";
import { apiFetch, type ClientConnection } from "../../api/api-client";
import { connectionQueryScope } from "../../lib/query-scope";
import { useErrorToast } from "../../app/AppToastContext";
import type { LocalPonderState } from "./ponder-local-types";

export function PonderConnections({state, connection, accountScopeKey, onSetup}: {state: LocalPonderState | null; connection: ClientConnection; accountScopeKey: string; onSetup(): void}) {
  const id = useId();
  const trigger = useRef<HTMLButtonElement>(null);
  const [open, setOpen] = useState(false);
  const [position, setPosition] = useState<CSSProperties>({});
  const hosted = useHostedSandboxes(connection, accountScopeKey, open);
  const remote = useQuery({
    queryKey: ["account-remote-access", connectionQueryScope(connection)], enabled: open,
    staleTime: 5000, refetchInterval: open ? 10000 : false,
    queryFn: ({signal}) => apiFetch<RemoteAccessSettingsStatus>(connection, "/v1/account-remote-access", {signal: AbortSignal.any([signal, AbortSignal.timeout(15000)])}),
  });
  useErrorToast(remote.error?.message ?? null);
  const remoteLabel = !remote.data ? (remote.isPending ? "Checking connection…" : "Unknown") : ({
    connected: "Connected", connecting: "Connecting", reconnecting: "Reconnecting", offline: "Offline",
    off: "Off", signed_out: "Sign in required", update_required: "Update required",
  } satisfies Record<RemoteAccessSettingsStatus["state"], string>)[remote.data.state];
  useEffect(() => {
    if (!open) return;
    function place() {
      const rect = trigger.current?.getBoundingClientRect();
      if (!rect) return;
      const width = Math.min(320, window.innerWidth - 24);
      setPosition({left:Math.max(12,Math.min(rect.left,window.innerWidth-width-12)),bottom:window.innerHeight-rect.top+8,
        width,maxHeight:Math.max(100,rect.top-24)});
    }
    place(); window.addEventListener("resize",place); window.addEventListener("scroll",place,true);
    return () => {window.removeEventListener("resize",place);window.removeEventListener("scroll",place,true);};
  },[open]);
  return <>
    <button ref={trigger} type="button" className="ponder-execution-control" popoverTarget={id}>Pal</button>
    <div id={id} popover="auto" className="ponder-connections" style={position} onToggle={event => setOpen(event.newState === "open")} role="dialog" aria-label="Pal connections">
      <h3>Connections</h3>
      <section className="ponder-access-section" aria-label="Desktop and remote access">
        <label><span>This desktop<small>{state?.session ? "Pal runs here" : "Set up Pal to start"}</small></span><input type="checkbox" role="switch" aria-label="This desktop execution" checked={Boolean(state?.session)} readOnly disabled/></label>
        {(["Web access", "iOS access"] as const).map(title => <div key={title} className="ponder-connection-card" role="group" aria-label={title}>
          <span>{title}<small>{remoteLabel}</small></span><span className={`ponder-connection-dot${remote.data?.state === "connected" ? " connected" : ""}`} role="img" aria-label={`${title}: ${remoteLabel}`} title="Shared desktop relay connection"/>
        </div>)}
      </section>
      <label className="ponder-hosted-sandboxes"><span>Hosted sandboxes<small>{hosted.loading ? "Checking availability…" : hosted.state?.enabled ? "Selected assignments may run in hosted Work." : hosted.state?.reason ?? "Allow selected assignments and required project context to run in hosted Work. Usage may incur charges."}</small></span><input type="checkbox" role="switch" aria-label="Hosted sandboxes enabled" checked={hosted.state?.enabled ?? false}
        disabled={!hosted.state || hosted.saving || (!hosted.state.available && !hosted.state.enabled)} onChange={event => hosted.setEnabled(event.currentTarget.checked)}/></label>
      <button type="button" onClick={onSetup}>Pal settings</button>
    </div>
  </>;
}
