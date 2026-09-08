import type { Taskset, TasksetDraft } from "@openpond/contracts";
import { api, type ClientConnection } from "../api";

type DraftMutation = <T>(key: string, path: string, body: unknown, method?: "POST" | "PUT" | "PATCH" | "DELETE") => Promise<T | null>;

export function tasksetDraftActions(connection: ClientConnection | null, profileId: string, mutate: DraftMutation, onError: (error: unknown) => void) {
  return {
    createTasksetDraft: (name = "", modelId?: string | null) =>
      mutate<TasksetDraft>("create-taskset-draft", "/taskset-drafts", { profileId, name, modelId: modelId ?? null }),
    importTasksetDraftPackage: (packagePath: string) =>
      mutate<TasksetDraft>("import-taskset-draft-package", "/taskset-drafts/import", { packagePath, profileId }),
    saveTasksetDraft: (draft: TasksetDraft) =>
      mutate<TasksetDraft>("save-taskset-draft", `/taskset-drafts/${encodeURIComponent(draft.id)}`, draft, "PUT"),
    tasksetDraftWorkspace: async (draftId: string) => {
      if (!connection) return null;
      try {
        return await api.trainingRequest<{ draftId: string; workspacePath: string; packageHash: string }>(
          connection, `/taskset-drafts/${encodeURIComponent(draftId)}/workspace`, {}, "GET",
        );
      } catch (error) { onError(error); return null; }
    },
    publishTasksetDraft: (draftId: string, modelId?: string | null) =>
      mutate<{ draft: TasksetDraft; taskset: Taskset; hostedSync: { state: "local" | "synced" | "sync_failed"; error: string | null } }>(
        "publish-taskset-draft", `/taskset-drafts/${encodeURIComponent(draftId)}/publish`, { modelId: modelId ?? null },
      ),
    refreshTasksetDraftModel: (draft: TasksetDraft, expectedModelRevision: number) =>
      mutate<TasksetDraft>("refresh-taskset-draft-model", `/taskset-drafts/${encodeURIComponent(draft.id)}/model-revision`,
        { expectedDraftRevision: draft.revision, expectedModelRevision }),
    deleteTasksetDraft: (draftId: string) =>
      mutate<{ deleted: boolean; draftId: string }>("delete-taskset-draft", `/taskset-drafts/${encodeURIComponent(draftId)}`, {}, "DELETE"),
  };
}
