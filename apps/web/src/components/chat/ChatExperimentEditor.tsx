import { useContext, useMemo, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import type { ClientConnection } from "../../api";
import type { useChatContextSelection } from "../../hooks/useChatContextSelection";
import { EvaluationSetupProvider, useEvaluationSetup } from "../labs/workspace/EvaluationSetupState";
import { WorkspacePanelHost } from "../labs/workspace/WorkspacePanel";
import { ExperimentSetupPanel } from "../labs/workspace/ExperimentSetupPanel";
import { createWorkspaceApi, type Inventory, type WorkspaceApi } from "../labs/workspace/workspace-api";
import { navigateModelsRoute } from "../labs/lab-primary-tab-state";
import { modelsLocation } from "../labs/models-route";
import { ErrorToast } from "../common/ErrorToast";
import { ChatExperimentWorkspaceContext } from "./ChatExperimentWorkspaceContext";
import "../../styles/labs/evaluation-workspace.css";

type Context = ReturnType<typeof useChatContextSelection>;
export function ChatExperimentEditor({ connection, context, onClose }: {
  connection: ClientConnection; context: Context; onClose: () => void;
}) {
  const scope = useContext(ChatExperimentWorkspaceContext);
  const draft = context.selection?.draft, record = context.selection?.storedDraft;
  const location = draft?.evaluationForm?.executionLocation ?? (draft?.operationType === "evaluate" ? "local" : "hosted");
  const api = useMemo(() => scope?.teamId && scope.actorId ? createWorkspaceApi(connection, {
    ...scope, teamId: scope.teamId, actorId: scope.actorId, projectId: record?.projectId ?? null, executionLocation: location,
  }) : null, [connection, scope?.accountKey, scope?.teamId, scope?.actorId, record?.projectId, location]);
  if (!draft) return null;
  if (draft.hostedEvaluationForm) return <div className="chat-experiment-tool-content">
    <ErrorToast error="Open this saved evaluation in its hosted editor to preserve its native settings." />
    <button type="button" className="training-button secondary" onClick={onClose}>Close editor</button>
  </div>;
  if (!api) return <div className="chat-experiment-tool-content"><p>Select an OpenPond workspace to configure this experiment.</p></div>;
  return <EvaluationSetupProvider key={`${api.key}:${draft.id}`} initialExperiment={draft} initialRecord={record} onNewDraft={async next => {
    const selected = await context.select({kind: "experiment", id: next.id, location: "local", draft: next}, {newExperiment: true});
    if (!selected) throw new Error("The new experiment could not be selected. Your original editor remains available.");
  }}>
    <EditorBody api={api} context={context} onClose={onClose} />
  </EvaluationSetupProvider>;
}
function EditorBody({ api, context, onClose }: { api: WorkspaceApi; context: Context; onClose: () => void }) {
  const setup = useEvaluationSetup();
  // Polling can discover a remote edit while this form is open. Keep the revision
  // that populated this editor; only its own successful save advances that base.
  const base = useRef(context.selection?.storedDraft ?? null);
  const [host, setHost] = useState<HTMLDivElement | null>(null);
  const inventory = useQuery({ queryKey: ["evaluation-workspace", api.key, "chat-inventory"],
    queryFn: ({ signal }) => api.request<Inventory>("inventory", {}, signal) });
  const navigate = (route: Parameters<typeof navigateModelsRoute>[0]) => { void navigateModelsRoute({ ...route, area: "console" }); };
  return <WorkspacePanelHost.Provider value={host}>
    <div ref={setHost} className="evaluation-workspace-panel chat-experiment-editor" />
    {inventory.error ? <ErrorToast error={inventory.error}><button type="button" className="training-text-button" onClick={() => void inventory.refetch()}>Retry workspace</button></ErrorToast> : null}
    <ExperimentSetupPanel key={setup.initialExperiment?.id} api={api} inventory={inventory.data ?? null}
      route={modelsLocation("experiments", null, { projectId: api.projectId, executionLocation: api.location })}
      navigate={navigate} onClose={onClose}
      onTrainingStarted={async id => {
        const current = inventory.data ?? await api.request<Inventory>("inventory");
        if (current.teamId !== api.teamId || !setup.initialExperiment) throw new Error("The originating workspace changed.");
        await context.associateTraining(id, current.apiOrigin, setup.initialExperiment.id);
      }}
      onSaveDraft={async draft => {
        const saved = await context.saveDraft(draft, base.current);
        if (saved.storedDraft) { base.current = saved.storedDraft; setup.acceptSaved(saved.storedDraft); }
        return saved;
      }}
      onSaved={({ id }) => navigate(modelsLocation("experiments", null, { resourceId: id, projectId: api.projectId,
        executionLocation: api.location, detailTab: "overview" }))} />
  </WorkspacePanelHost.Provider>;
}
