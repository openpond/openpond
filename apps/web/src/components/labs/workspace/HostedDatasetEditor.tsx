import { useMemo, useRef, useState } from "react";
import type { DatasetWorkspaceReceipt } from "openpond-sdk/dataset-workspaces";
import type { ChatModelRef, TasksetDraft } from "@openpond/contracts";
import { TasksetDraftEditor } from "../../datasets/TasksetDraftEditor";
import type { TasksetDraftAuthoringClient } from "../../datasets/taskset-draft-authoring-client";
import type { WorkspaceApi } from "./workspace-api";
import { WorkspacePanel } from "./WorkspacePanel";
export function HostedDatasetEditor({ api, existing, onClose, onSaved }: { api: WorkspaceApi; existing: DatasetWorkspaceReceipt | null; onClose: (id?: string) => void; onSaved: (id: string) => void }) {
  const receipt = useRef(existing);
  const [draft, setDraft] = useState(existing?.workspace.draft ?? null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const actions = useMemo<TasksetDraftAuthoringClient["actions"]>(() => {
    async function execute<T>(operation: string, value: unknown) { setBusy(operation); setError(null); try { return await api.request<T>(operation, value); } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); return null; } finally { setBusy(null); } }
    async function update(operation: string, value: unknown) { const result = await execute<DatasetWorkspaceReceipt>(operation, value); if (result) { receipt.current = result; setDraft(result.workspace.draft); } return result?.workspace.draft ?? null; }
    return {
      async createTasksetDraft(name = "") { const operation = api.operation("createDraft", { name }); const result = await update("createDraft", { name, id: `dataset-${operation.id}`, now: operation.createdAt, operationId: operation.id }); if (result) operation.acknowledge(); return result; },
      async saveTasksetDraft(value: TasksetDraft) { const input = { id: value.id, draft: value, now: value.updatedAt }; return update("saveDraft", { ...input, operationId: api.operation("saveDraft", input).id }); },
      async tasksetDraftWorkspace(id) { const result = await execute<DatasetWorkspaceReceipt>("dataset", { id }); if (result) receipt.current = result; return result ? { draftId: id, workspacePath: "Hosted workspace", packageHash: result.workspace.contentHash } : null; },
      async tasksetDraftFiles(id) { return execute("draftFiles", { id }); },
      async tasksetDraftFile(id, path) { return execute("draftFile", { id, path }); },
      async saveTasksetDraftFile(mutation) { const intent = { id: mutation.draftId, mutation }; const operation = api.operation("saveDraftFile", intent); const result = await update("saveDraftFile", { ...intent, now: operation.createdAt, operationId: operation.id }); if (result) operation.acknowledge(); return result; },
      async publishTasksetDraft(id) { const intent = { id, revision: receipt.current?.revision }; return execute("publishDraft", { id, operationId: api.operation("publishDraft", intent).id }); },
      async refreshTasksetDraftModel() { throw new Error("Independent hosted datasets have no Model-owned draft source."); },
    };
  }, [api]);
  const writing = busy && ["createDraft", "saveDraft", "saveDraftFile", "publishDraft"].includes(busy);
  const authoring: TasksetDraftAuthoringClient = { payload: { tasksetDrafts: draft ? [draft] : [], modelProjects: [] }, busyAction: writing ? `taskset-draft:${busy}` : null, actions, refresh: async () => { if (!receipt.current) return null; const value = await api.request<DatasetWorkspaceReceipt>("dataset", { id: receipt.current.datasetId }); receipt.current = value; setDraft(value.workspace.draft); return { tasksetDrafts: [value.workspace.draft], modelProjects: [] }; } };
  const defaultModel: ChatModelRef = { providerId: "openpond", modelId: "openpond-chat" };
  return <WorkspacePanel action="dataset" label="Dataset editor"><header><h2>{existing ? "Edit dataset draft" : "Create dataset"}</h2></header>{error ? <p role="alert">{error}</p> : null}<TasksetDraftEditor owner="hosted" draftId={existing?.datasetId} defaultModel={defaultModel} training={authoring} onBack={() => onClose(receipt.current?.datasetId)} onPublished={() => { if (receipt.current) onSaved(receipt.current.datasetId); }} /></WorkspacePanel>;
}
