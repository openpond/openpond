import { ModelTasksetDraftRequestSchema, TasksetDraftFileMutationSchema } from "openpond-sdk/model-taskset-authoring";
import type { SqliteStore } from "../store/store.js";
import { exportLocalModelTasksetPackage } from "./model-taskset-package-export.js";

type Dependencies = { store: SqliteStore; storeDir: string };

export async function inspectModelTasksetDraftSource(deps: Dependencies, input: { profileId: string; modelId: string; expectedModelRevision: unknown }) {
  const model = await deps.store.getModelProject(input.modelId);
  if (!model || model.profileId !== input.profileId) throw new Error("Taskset draft Model was not found in this Profile.");
  if (model.revision !== input.expectedModelRevision) throw new Error("Model changed before draft inspection. Refresh before editing.");
  const source = await exportLocalModelTasksetPackage({ ...deps, profileId: input.profileId, modelId: input.modelId });
  if (source.learningResources) throw new Error("Reviewed Tasksets require their reviewed authoring workflow.");
  return { modelId: model.id, expectedModelRevision: model.revision, sourcePackageHash: source.contentHash };
}

export async function initializeModelTasksetDraftSource(deps: Dependencies, input: { profileId: string; sourceRequest: unknown; modelId?: unknown }) {
  const request = ModelTasksetDraftRequestSchema.parse(input.sourceRequest);
  if (input.modelId !== undefined && input.modelId !== request.modelId) throw new Error("Taskset draft belongs to another Model.");
  const retained = await deps.store.initializeModelTasksetDraft(input.profileId, request);
  if (retained) return retained;
  const source = await exportLocalModelTasksetPackage({ ...deps, profileId: input.profileId, modelId: request.modelId });
  return deps.store.initializeModelTasksetDraft(input.profileId, request, source);
}

export async function tasksetDraftFileAction(store: SqliteStore, action: string, input: Record<string, unknown>) {
  if (typeof input.profileId !== "string" || !input.profileId.trim()) throw new Error("profileId is required.");
  if (typeof input.draftId !== "string" || !input.draftId.trim()) throw new Error("draftId is required.");
  if (action === "save_taskset_draft_file") {
    const { profileId, ...mutation } = input;
    return store.saveTasksetDraftFile(profileId, TasksetDraftFileMutationSchema.parse(mutation));
  }
  if (action === "taskset_draft_file" && typeof input.path !== "string") throw new Error("path is required.");
  return store.tasksetDraftFiles(input.profileId, input.draftId, action === "taskset_draft_file" ? input.path as string : undefined);
}
