import { useMemo, useRef, useState } from "react";
import type { DatasetWorkspaceReceipt } from "openpond-sdk/dataset-workspaces";
import type { ChatModelRef, TasksetDraft } from "@openpond/contracts";
import { TasksetDraftEditor } from "../../datasets/TasksetDraftEditor";
import type { TasksetDraftAuthoringClient } from "../../datasets/taskset-draft-authoring-client";
import type { WorkspaceApi } from "./workspace-api";
import { WorkspacePanel } from "./WorkspacePanel";
export function HostedDatasetEditor({ api, existing, onClose, onSaved }: { api: WorkspaceApi; existing: DatasetWorkspaceReceipt | null; onClose: () => void; onSaved: (id: string) => void }) {
  const receipt = useRef(existing);
  const initial = useRef({ id: `dataset-${crypto.randomUUID()}`, now: new Date().toISOString(), name: "" });
  const [draft, setDraft] = useState(existing?.workspace.draft ?? null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const actions = useMemo<TasksetDraftAuthoringClient["actions"]>(() => {
    async function execute<T>(operation: string, value: unknown) { setBusy(operation); setError(null); try { return await api.request<T>(operation, value); } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); return null; } finally { setBusy(null); } }
    async function update(operation: string, value: unknown) { const result = await execute<DatasetWorkspaceReceipt>(operation, value); if (result) { receipt.current = result; setDraft(result.workspace.draft); } return result?.workspace.draft ?? null; }
    return {
      async createTasksetDraft(name = "") { const intent = { ...initial.current, name }; return update("createDraft", { ...intent, operationId: api.operation("createDraft", intent).id }); },
      async saveTasksetDraft(value: TasksetDraft) { const input = { id: value.id, draft: value, now: value.updatedAt }; return update("saveDraft", { ...input, operationId: api.operation("saveDraft", input).id }); },
      async tasksetDraftWorkspace(id) { const result = await execute<DatasetWorkspaceReceipt>("dataset", { id }); if (result) receipt.current = result; return result ? { draftId: id, workspacePath: "Hosted workspace", packageHash: result.workspace.contentHash } : null; },
      async tasksetDraftFiles(id) { return execute("draftFiles", { id }); },
      async tasksetDraftFile(id, path) { return execute("draftFile", { id, path }); },
      async saveTasksetDraftFile(mutation) { const intent = { id: mutation.draftId, mutation, now: new Date().toISOString() }; return update("saveDraftFile", { ...intent, operationId: api.operation("saveDraftFile", intent).id }); },
      async publishTasksetDraft(id) { const intent = { id, revision: receipt.current?.revision }; return execute("publishDraft", { id, operationId: api.operation("publishDraft", intent).id }); },
      async refreshTasksetDraftModel() { throw new Error("Independent hosted datasets have no Model-owned draft source."); },
    };
  }, [api]);
  const authoring: TasksetDraftAuthoringClient = { payload: { tasksetDrafts: draft ? [draft] : [], modelProjects: [] }, busyAction: busy ? `taskset-draft:${busy}` : null, actions, refresh: async () => { if (!receipt.current) return null; const value = await api.request<DatasetWorkspaceReceipt>("dataset", { id: receipt.current.datasetId }); receipt.current = value; setDraft(value.workspace.draft); return { tasksetDrafts: [value.workspace.draft], modelProjects: [] }; } };
  const defaultModel: ChatModelRef = { providerId: "openpond", modelId: "openpond-chat" };
  return <WorkspacePanel label="Dataset editor"><header><h2>{existing ? "Edit dataset draft" : "Create dataset"}</h2></header>{error ? <p role="alert">{error}</p> : null}<TasksetDraftEditor owner="hosted" draftId={existing?.datasetId} defaultModel={defaultModel} training={authoring} onBack={onClose} onPublished={() => { if (receipt.current) onSaved(receipt.current.datasetId); }} /></WorkspacePanel>;
}
