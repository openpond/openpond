import type { ClientConnection } from "../../api/api-client";
import { useHostedSandboxes } from "./useHostedSandboxes";

export function HostedSandboxesSetting({connection, accountScopeKey}: {connection: ClientConnection; accountScopeKey: string}) {
  const hosted = useHostedSandboxes(connection, accountScopeKey);
  const disabled = !hosted.state || hosted.saving || (!hosted.state.available && !hosted.state.enabled);
  return <div className="ponder-setup-card">
    <label><strong>Hosted sandboxes</strong><input type="checkbox" role="switch" aria-label="Hosted sandboxes" checked={hosted.state?.enabled ?? false}
      disabled={disabled} onChange={event => hosted.setEnabled(event.currentTarget.checked)}/></label>
    <p>Allow Pal to send selected assignments and their required project context to hosted Work environments. Hosted usage may incur charges.</p>
    <small>{hosted.loading ? "Checking availability…" : hosted.state?.enabled ? "Enabled for this account. Turning this off prevents new hosted assignments; existing work stays available." : hosted.state?.reason ?? "Off. Turn on to allow hosted assignments."}</small>
    {!hosted.state && !hosted.loading ? <button type="button" className="git-dialog-secondary" onClick={() => void hosted.refetch()}>Check availability</button> : null}
  </div>;
}
