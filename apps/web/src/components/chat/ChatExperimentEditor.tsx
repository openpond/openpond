import { useContext, useMemo, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { ownsHostedBenchmarkVersion } from "@openpond/contracts/resource-setup";
import type { ClientConnection } from "../../api";
import { chatResourceRequest } from "../../api/chat-resource-api";
import type { useChatContextSelection } from "../../hooks/useChatContextSelection";
import { EvaluationSetupProvider, useEvaluationSetup } from "../labs/workspace/EvaluationSetupState";
import { WorkspacePanelHost } from "../labs/workspace/WorkspacePanel";
import { ExperimentSetupPanel } from "../labs/workspace/ExperimentSetupPanel";
import { createWorkspaceApi, type Inventory, type WorkspaceApi } from "../labs/workspace/workspace-api";
import { navigateModelsRoute } from "../labs/lab-primary-tab-state";
import { modelsLocation } from "../labs/models-route";
import { ErrorToast } from "../common/ErrorToast";
import { ChatExperimentWorkspaceContext } from "./ChatExperimentWorkspaceContext";
import { LocalAdapterBenchmarkReview } from "./LocalAdapterBenchmarkReview";
import "../../styles/labs/evaluation-workspace.css";

type Context = ReturnType<typeof useChatContextSelection>;
export function ChatExperimentEditor({ connection, context, onClose }: {
  connection: ClientConnection; context: Context; onClose: () => void;
}) {
  const scope = useContext(ChatExperimentWorkspaceContext);
  const draft = context.selection?.draft, record = context.selection?.storedDraft;
  const trained = draft?.operationType === "evaluate" && draft.startingModel?.source === "trained" ? draft.startingModel.trainedVersion : null;
  const location = trained ? "hosted" : draft?.evaluationForm?.executionLocation ?? (draft?.operationType === "evaluate" ? "local" : "hosted");
  const api = useMemo(() => scope?.teamId && scope.actorId ? createWorkspaceApi(connection, {
    ...scope, teamId: scope.teamId, actorId: scope.actorId, projectId: record?.projectId ?? null, executionLocation: location,
  }) : null, [connection, scope?.accountKey, scope?.teamId, scope?.actorId, record?.projectId, location]);
  if (!draft) return null;
  const version = context.selection?.benchmarkVersion;
  if (version?.location === "cloud" && !ownsHostedBenchmarkVersion(version, scope))
    return <div className="chat-experiment-tool-content">
      <p>Choose the OpenPond account and workspace that owns this Benchmark.</p>
      <button type="button" className="training-button secondary" onClick={onClose}>Close editor</button>
    </div>;
  if (context.selection?.benchmarkVersion?.location === "local" && context.selection.target.sessionId)
    return <div className="chat-experiment-tool-content">
      <LocalAdapterBenchmarkReview connection={connection} sessionId={context.selection.target.sessionId} />
      <button type="button" className="training-button secondary" onClick={onClose}>Close editor</button>
    </div>;
  if (draft.hostedEvaluationForm) return <div className="chat-experiment-tool-content">
    <ErrorToast error="Open this saved evaluation in its hosted editor to preserve its native settings." />
    <button type="button" className="training-button secondary" onClick={onClose}>Close editor</button>
  </div>;
  if (!api) return <div className="chat-experiment-tool-content"><p>Select an OpenPond workspace to configure this experiment.</p></div>;
  if (trained && api.teamId !== trained.teamId)
    return <p>Choose the workspace that owns this saved Model version to review the Benchmark.</p>;
  const localTrainingDraft = Boolean(context.selection?.localDraft && draft.trainingForm);
  return <EvaluationSetupProvider key={`${api.key}:${draft.id}:${trained?.contentHash ?? ""}`} initialExperiment={draft} initialRecord={record}
    allowedOperationTypes={localTrainingDraft || trained ? [draft.operationType] : undefined} onNewDraft={async next => {
    const selected = await context.select({kind: "experiment", id: next.id, location: "local", draft: next}, {newExperiment: true});
    if (!selected) throw new Error("The new experiment could not be selected. Your original editor remains available.");
  }}>
    <EditorBody api={api} context={context} localTrainingDraft={localTrainingDraft} onClose={onClose} />
  </EvaluationSetupProvider>;
}
function EditorBody({ api, context, localTrainingDraft, onClose }: { api: WorkspaceApi; context: Context; localTrainingDraft: boolean; onClose: () => void }) {
  const setup = useEvaluationSetup();
  // Polling can discover a remote edit while this form is open. Keep the revision
  // that populated this editor; only its own successful save advances that base.
  const base = useRef(context.selection?.storedDraft ?? null);
  const savedBenchmarkVersions = useRef(base.current ? context.selection?.managedBenchmarkVersions : undefined);
  const [host, setHost] = useState<HTMLDivElement | null>(null);
  const inventory = useQuery({ queryKey: ["evaluation-workspace", api.key, "chat-inventory"],
    queryFn: ({ signal }) => api.request<Inventory>("inventory", {}, signal) });
  const navigate = (route: Parameters<typeof navigateModelsRoute>[0]) => { void navigateModelsRoute({ ...route, area: "console" }); };
  const sessionId = context.selection?.target.sessionId;
  const hostedBenchmark = context.selection?.localDraft && context.selection.benchmarkVersion?.location === "cloud" && sessionId;
  return <WorkspacePanelHost.Provider value={host}>
    <div ref={setHost} className="evaluation-workspace-panel chat-experiment-editor" />
    {inventory.error ? <ErrorToast error={inventory.error}><button type="button" className="training-text-button" onClick={() => void inventory.refetch()}>Retry workspace</button></ErrorToast> : null}
    <ExperimentSetupPanel key={setup.initialExperiment?.id} api={api} inventory={inventory.data ?? null} localTrainingDraft={localTrainingDraft}
      bindBenchmark={hostedBenchmark ? async (preparationId, revision, versionHash) => {
        await chatResourceRequest(api.connection, "dataset", { action: "context_bind_benchmark", payload: { sessionId, preparationId, revision, versionHash } });
      } : undefined}
      recoverBenchmark={hostedBenchmark ? async (revision, versionHash) => {
        const value = await chatResourceRequest<{ preparationId: string | null }>(api.connection, "dataset", {
          action: "context_recover_benchmark", payload: { sessionId, revision, versionHash },
        });
        return value.preparationId;
      } : undefined}
      retainedBenchmark={context.selection?.localDraft && context.selection.draft && context.selection.draftRevision
        ? { draft: context.selection.draft, revision: context.selection.draftRevision, versions: context.selection.managedBenchmarkVersions } : undefined}
      savedBenchmarkVersions={savedBenchmarkVersions.current}
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
