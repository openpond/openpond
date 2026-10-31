import { useState } from "react";
import { useErrorToast } from "../../app/AppToastContext";
import { navigateDesktopRoute, modelsLocation } from "../labs/lab-primary-tab-state";
import { EvaluationTableState } from "../labs/workspace/EvaluationTableState";
import { captureClientName, useCaptureDestination, useToolConnections, type FixItContext } from "./client";
import { FixItSetup } from "./FixItSetup";

export function FixItConnections({ context, baseUrl }: { context: FixItContext; baseUrl: string }) {
  const dataset = useCaptureDestination(context), connections = useToolConnections(context);
  const [setup, setSetup] = useState(false);
  useErrorToast(dataset.error);
  const destination = dataset.data;
  const items = connections.data?.installations.filter(item => item.state !== "revoked") ?? [];
  function refresh() { void dataset.refetch(); void connections.refetch(); }
  return <section className="connected-agents-view" aria-label="Fix-it connections">
    <header className="agent-connections-heading"><div><h2>Fix-it</h2><p>Tool errors from all your connected agents go to one private saved dataset.</p></div>
      <div className="agent-connections-actions"><button onClick={refresh} disabled={dataset.isFetching || connections.isFetching}>Refresh</button><button className="agent-connect-button" onClick={() => setSetup(true)}>Connect agent</button></div></header>
    <div className="evaluation-card"><h3>Destination: {destination?.name ?? "Fix-it"}</h3><p>{destination ? `${destination.taskCount ?? 0} saved records` : "Loading dataset…"}</p>
      <button className="training-text-button" disabled={!destination} onClick={() => destination && void navigateDesktopRoute({ kind: "models", route: modelsLocation("datasets", null, { area: "console", resourceId: destination.id, detailTab: "tasks", projectId: null, executionLocation: "hosted" }) })}>Open dataset</button>
      {dataset.error ? <button className="training-text-button" onClick={() => void dataset.refetch()}>Retry</button> : null}
    </div>
    <div className="evaluation-table-scroll evaluation-table-frame"><table className="training-data-table evaluation-workspace-table"><thead><tr><th>Agent</th><th>Capture</th><th>Tools</th><th>Dataset</th></tr></thead><tbody>
      {items.map(item => <tr key={item.id}><td><div>{captureClientName(item.client)}</div><small>{item.clientVersion}</small></td>
        <td>{item.state === "enabled" ? "Enabled" : "Paused"}</td><td>{item.collectionPolicy.permittedTools.join(", ")}</td><td>{destination?.name ?? "Fix-it"}</td></tr>)}
      <EvaluationTableState columns={4} loading={connections.isPending} error={connections.error?.message} retry={() => void connections.refetch()} empty={!items.length}>Connect a coding agent to start capturing tool errors.</EvaluationTableState>
    </tbody></table></div>
    <p className="evaluation-meta-line">Captures are saved as dataset records. Recovery candidates need separate review before training.</p>
    {setup ? <FixItSetup context={context} baseUrl={baseUrl} onClose={() => setSetup(false)} /> : null}
  </section>;
}
