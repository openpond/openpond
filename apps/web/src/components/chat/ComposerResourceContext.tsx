import { experimentOperationLabel } from "openpond-sdk/training";
import { useState } from "react";
import type { ChatContextTarget } from "@openpond/contracts";
import type { useChatContextSelection } from "../../hooks/useChatContextSelection";
import type { useChatResourceFocus } from "../../hooks/useChatResourceFocus";
import { ErrorToast } from "../common/ErrorToast";
import { ComposerResourceControls } from "./ComposerResourceControls";
import { ComposerTrainingControls } from "./ComposerTrainingControls";
import { addResourceRequestToChat } from "./composer-resource-request";
import { datasetWorkspaceContext, resourceIdentity } from "./dataset-workspace-data";
import { CHAT_CONTEXT_SELECTED } from "../../hooks/useChatContextSelection";

/** Keep the original controls bound to the same canonical focus as the sidebar. */
export function ComposerResourceContext({ context, resources, sessionId, busy }: {
  context: ReturnType<typeof useChatContextSelection>;
  resources: ReturnType<typeof useChatResourceFocus>;
  sessionId: string | null;
  busy: boolean;
}) {
  const [error, setError] = useState<string | null>(null);
  const selected = context.selection;
  if (!selected) return null;
  if (selected.model || selected.training) return <ComposerTrainingControls context={context} sessionId={sessionId} busy={busy} />;
  if (selected.draft && selected.draft.operationType !== "evaluate") return <div className="composer-resource-area">
    <div className="composer-resource-bar" aria-label="Current experiment draft">
      <span className="composer-resource-dataset-name">{selected.label}</span>
      <span>{experimentOperationLabel(selected.draft.operationType)}</span>
      <button type="button" className="composer-resource-primary" disabled={busy || context.selecting}
        onClick={() => window.dispatchEvent(new CustomEvent(CHAT_CONTEXT_SELECTED, { detail: { sessionId, scope: context.scope, targetKey: JSON.stringify(selected.target) } }))}>View draft</button>
    </div>
  </div>;
  const dataset = selected.dataset ?? (selected.resource?.kind === "dataset" ? selected.resource : null);
  const run = selected.resource?.kind === "experiment" ? selected.resource : null;
  const scope = resources.scope;
  const matches = Boolean(scope && (selected.draft && selected.target.scopeId === scope.id || dataset && scope.dataset && resourceIdentity(dataset) === resourceIdentity(scope.dataset)
    && dataset.revision === scope.dataset.revision
    && (selected.target.scopeId === scope.id || selected.target.kind === "dataset" || run && scope.runs.some(item => resourceIdentity(item) === resourceIdentity(run)))));
  // Resource loading must not expose another chat's scope or mutate a different revision.
  if (!matches) return null;
  async function select(target: ChatContextTarget | null) {
    setError(null);
    try { await context.select(target); return true; }
    catch (cause) { setError(cause instanceof Error ? cause.message : "Resource selection failed."); return false; }
  }
  const scoped = {
    ...resources,
    focus: { ...resources.focus, dataset, experiment: run },
    graders: selected.graders ?? resources.graders,
    selecting: resources.selecting || context.selecting,
    selectScope: (scopeId: string) => select({ kind: "experiment", id: scopeId, scopeId, sessionId: sessionId!, location: "local" }),
    select: (kind: "dataset" | "experiment" | "grader", id: string, revision?: number) => {
      if (kind === "grader") return resources.select(kind, id, revision);
      if (!id) return select(null);
      const target = context.catalog.data?.options.find(item => item.target.kind === kind && item.target.id === id && (revision === undefined || item.target.revision === revision))?.target;
      const record = [...resources.datasets, ...resources.experiments].find(item => item.kind === kind && item.id === id && (revision === undefined || item.revision === revision));
      if (!target && !record) { setError("This resource is no longer available. Choose it again from Ponder."); return Promise.resolve(false); }
      return select(target ?? { kind, id, revision, location: record!.location ?? "local" });
    },
  };
  return <>
    <ComposerResourceControls resources={scoped} busy={busy} onDraft={(text, training) => {
      addResourceRequestToChat({ sessionId, text, contexts: datasetWorkspaceContext(scoped, run ?? undefined, training) });
    }} />
    <ErrorToast error={error} />
  </>;
}
