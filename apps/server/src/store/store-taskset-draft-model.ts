import type { Taskset, TasksetDraft } from "@openpond/contracts";
import { contentHash } from "@openpond/harness";
import { sameLearningRef } from "@openpond/evals/learning";
import { ModelProjectEditableSchema, ModelProjectSchema, ModelProjectVersionedRefSchema } from "openpond-sdk/model-projects";
import type { OpenPondSqliteConnection } from "./sqlite/sqlite-driver.js";
import { saveModelProjectInTransaction } from "./store-model-project-authoring.js";
import type { TasksetPackage } from "openpond-sdk/taskset-packages";

/** Called inside draft finalization's transaction, after its immutable Taskset
 * write. A Model conflict rolls back the draft, Taskset and selection together. */
export function selectTasksetDraftModel(db: OpenPondSqliteConnection, draft: TasksetDraft, taskset: Taskset, completePackage?: TasksetPackage | null) {
  const scope = draft.modelScope;
  if (!scope) return;
  const row = db.get<{ payload: string }>("SELECT payload FROM model_projects WHERE id = ? AND profile_id = ?", [scope.modelId, draft.profileId]);
  if (!row) throw new Error("Taskset draft Model was not found in this Profile.");
  const model = ModelProjectSchema.parse(JSON.parse(row.payload));
  const tasksetRef = { id: taskset.id, revision: taskset.revision, contentHash: taskset.contentHash };
  const rewardBindingRef = taskset.metadata.rewardBinding === undefined ? null : ModelProjectVersionedRefSchema.parse(taskset.metadata.rewardBinding);
  // Editing the tasks under the same bound Reward must preserve the owner's
  // context, optimizer and continuation settings. A different Reward still
  // requires a newly derived recipe through the normal defaults path.
  const preserveRecipe = scope.source?.authoringGraph === "bound"
    && rewardBindingRef && model.trainingSetup.rewardBindingRef
    && sameLearningRef(rewardBindingRef, model.trainingSetup.rewardBindingRef);
  return saveModelProjectInTransaction(db, {
    schemaVersion: "openpond.modelProjectSave.v1",
    operationId: `draft-publication:${contentHash({ draftId: draft.id, revision: draft.revision, scope, tasksetRef })}`,
    expectedRevision: scope.expectedModelRevision,
    project: ModelProjectEditableSchema.strip().parse({
      ...model,
      trainingSetup: {
        ...model.trainingSetup,
        tasksetRef,
        rewardBindingRef,
        tasksetRelease: null,
        recipe: preserveRecipe ? model.trainingSetup.recipe : null,
        ...(model.trainingSetup.evaluationTasksetRef && model.trainingSetup.tasksetRef && sameLearningRef(model.trainingSetup.evaluationTasksetRef, model.trainingSetup.tasksetRef) ? { evaluationTasksetRef: tasksetRef } : {}),
      },
    }),
  }, null, completePackage?.modelResources ? { ...completePackage.modelResources, taskset: completePackage.taskset,
    executionResources: { environment: completePackage.environment, verifierSet: completePackage.verifierSet } } : completePackage ?? undefined);
}
