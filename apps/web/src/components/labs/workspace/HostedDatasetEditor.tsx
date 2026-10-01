import { publishTasksetDraft } from "openpond-sdk/taskset-drafts";
import { useMemo, useRef, useState } from "react";
import type { DatasetWorkspaceReceipt } from "openpond-sdk/dataset-workspaces";
import type { ChatModelRef, TasksetDraft } from "@openpond/contracts";
import { TasksetDraftEditor, type TasksetDraftEditorHandle } from "../../datasets/TasksetDraftEditor";
import type { TasksetDraftAuthoringClient } from "../../datasets/taskset-draft-authoring-client";
import type { WorkspaceApi } from "./workspace-api";
import { WorkspacePanel } from "./WorkspacePanel";
export function HostedDatasetEditor({ api, existing, onClose, onSaved }: { api: WorkspaceApi; existing: DatasetWorkspaceReceipt | null; onClose: (id?: string) => void; onSaved: (id: string) => void }) {
  const receipt = useRef(existing);
  const editor = useRef<TasksetDraftEditorHandle | null>(null);
  const [draft, setDraft] = useState(existing?.workspace.draft ?? null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const actions = useMemo<TasksetDraftAuthoringClient["actions"]>(() => {
    async function execute<T>(operation: string, value: unknown) { setBusy(operation); setError(null); try { return await api.request<T>(operation, value); } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); return null; } finally { setBusy(null); } }
    async function update(operation: string, value: unknown) { const result = await execute<DatasetWorkspaceReceipt>(operation, value); if (result) { receipt.current = result; setDraft(result.workspace.draft); } return result?.workspace.draft ?? null; }
    return {
      async createTasksetDraft(name = "") { const operation = await api.operation("createDraft", { name }); const result = await update("createDraft", { name, id: `dataset-${operation.id}`, now: operation.createdAt, operationId: operation.id }); if (result) await operation.acknowledge(); return result; },
      async saveTasksetDraft(value: TasksetDraft) { const input = { id: value.id, draft: value, now: value.updatedAt }; return update("saveDraft", { ...input, operationId: (await api.operation("saveDraft", input)).id }); },
      async tasksetDraftWorkspace(id) { const result = await execute<DatasetWorkspaceReceipt>("dataset", { id }); if (result) receipt.current = result; return result ? { draftId: id, workspacePath: "Hosted workspace", packageHash: result.workspace.contentHash } : null; },
      async tasksetDraftFiles(id) { return execute("draftFiles", { id }); },
      async tasksetDraftFile(id, path) { return execute("draftFile", { id, path }); },
      async saveTasksetDraftFile(mutation) { const intent = { id: mutation.draftId, mutation }; const operation = await api.operation("saveDraftFile", intent); const result = await update("saveDraftFile", { ...intent, now: operation.createdAt, operationId: operation.id }); if (result) await operation.acknowledge(); return result; },
      async publishTasksetDraft(id) {
        const current = receipt.current;
        if (current?.workspace.draft.metadata.connectedActivity) {
          const intent = { datasetId: id, expectedRevision: current.revision }, operation = await api.operation("connectedPublishDataset", intent);
          const result = await execute<DatasetWorkspaceReceipt>("connectedPublishDataset", { ...intent, operationId: operation.id });
          if (!result?.publication) return null;
          receipt.current = result; setDraft(result.workspace.draft); await operation.acknowledge();
          return { draft: result.workspace.draft, taskset: publishTasksetDraft({ draft: current.workspace.draft, now: current.workspace.draft.updatedAt, sourcePackageHash: current.workspace.contentHash }), hostedSync: { state: "synced" as const, error: null } };
        }
        const intent = { id, revision: current?.revision }; return execute("publishDraft", { id, operationId: (await api.operation("publishDraft", intent)).id });
      },
      async refreshTasksetDraftModel() { throw new Error("Independent hosted datasets have no Model-owned draft source."); },
    };
  }, [api]);
  const writing = busy && ["createDraft", "saveDraft", "saveDraftFile", "publishDraft", "connectedPublishDataset"].includes(busy);
  const authoring: TasksetDraftAuthoringClient = { payload: { tasksetDrafts: draft ? [draft] : [], modelProjects: [] }, busyAction: writing ? `taskset-draft:${busy}` : null, actions, refresh: async () => { if (!receipt.current) return null; const value = await api.request<DatasetWorkspaceReceipt>("dataset", { id: receipt.current.datasetId }); receipt.current = value; setDraft(value.workspace.draft); return { tasksetDrafts: [value.workspace.draft], modelProjects: [] }; } };
  const defaultModel: ChatModelRef = { providerId: "openpond", modelId: "openpond-chat" };
  return <WorkspacePanel action="dataset" label="Dataset editor" onRequestClose={() => editor.current?.requestClose()}><header><h2>{existing ? "Edit dataset draft" : "Create dataset"}</h2></header>{error ? <p role="alert">{error}</p> : null}<TasksetDraftEditor closeRef={editor} owner="hosted" draftId={existing?.datasetId} defaultModel={defaultModel} training={authoring} onBack={() => onClose(receipt.current?.datasetId)} onPublished={() => { if (receipt.current) onSaved(receipt.current.datasetId); }} /></WorkspacePanel>;
}
