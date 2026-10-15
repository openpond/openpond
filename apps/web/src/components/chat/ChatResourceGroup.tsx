import { useId, useState } from "react";
import type { ChatResourceSummary as Resource } from "@openpond/contracts";
import type { ClientConnection } from "../../api/api-client";
import { ChatResourceSummary } from "./ChatResourceSummary";
import { ChatResourceToolbar } from "./ChatResourceToolbar";

/** Keep related dataset/grader receipts together instead of stacking headers. */
export function ChatResourceGroup({ resources, connection, context }: {
  resources: Resource[]; connection: ClientConnection | null; context?: { sessionId: string; turnId: string };
}) {
  const [expanded, setExpanded] = useState(false);
  const detailsId = useId();
  const dataset = resources.find(resource => resource.kind === "dataset");
  const related = dataset && resources.length > 1 && resources.every(resource => resource === dataset ||
    resource.kind === "grader" && resource.datasetId === dataset.id && resource.datasetRevision === dataset.revision
    && JSON.stringify(resource.owner ?? null) === JSON.stringify(dataset.owner ?? null)
    && JSON.stringify(resource.profileRef ?? null) === JSON.stringify(dataset.profileRef ?? null));
  const cards = resources.map(resource => <ChatResourceSummary key={`${resource.kind}:${resource.id}`}
    initial={resource} connection={connection} context={context} />);
  if (!related || !dataset) return <>{cards}</>;
  const count = resources.length - 1;
  return <section className="chat-resource-summary compact" aria-label={`Resources for ${dataset.name}`}>
    <ChatResourceToolbar name={dataset.name} version={dataset.revision}
      summary={`${count} grader${count === 1 ? "" : "s"}`}
      primary={{ label: expanded ? "Close" : "Inspect", expanded, controls: detailsId, run: () => setExpanded(value => !value) }} />
    {expanded ? <div id={detailsId} className="chat-resource-group-details">{cards}</div> : null}
  </section>;
}
