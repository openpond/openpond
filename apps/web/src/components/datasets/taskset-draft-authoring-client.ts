import type { useTraining } from "../../hooks/useTraining";
type Training = ReturnType<typeof useTraining>;
/** Authoring is shared by local folders and independently hosted workspaces.
 * Runtime dispatch/training operations are intentionally outside this surface. */
export type TasksetDraftAuthoringClient = {
  payload: Pick<NonNullable<Training["payload"]>, "tasksetDrafts" | "modelProjects"> | null;
  busyAction: string | null;
  actions: Pick<Training["actions"], "createTasksetDraft" | "saveTasksetDraft" | "publishTasksetDraft" | "refreshTasksetDraftModel" | "tasksetDraftWorkspace" | "tasksetDraftFiles" | "tasksetDraftFile" | "saveTasksetDraftFile">;
  refresh: () => Promise<Pick<NonNullable<Training["payload"]>, "tasksetDrafts" | "modelProjects"> | null>;
};
