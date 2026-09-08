import type { Taskset, TasksetDraft } from "@openpond/contracts";
import { contentHash } from "@openpond/harness";
import { ModelProjectEditableSchema, ModelProjectSchema, ModelProjectVersionedRefSchema } from "openpond-sdk/model-projects";
import type { OpenPondSqliteConnection } from "./sqlite/sqlite-driver.js";
import { saveModelProjectInTransaction } from "./store-model-project-authoring.js";

/** Called inside draft finalization's transaction, after its immutable Taskset
 * write. A Model conflict rolls back the draft, Taskset and selection together. */
export function selectTasksetDraftModel(db: OpenPondSqliteConnection, draft: TasksetDraft, taskset: Taskset) {
  const scope = draft.modelScope;
  if (!scope) return;
  const row = db.get<{ payload: string }>("SELECT payload FROM model_projects WHERE id = ? AND profile_id = ?", [scope.modelId, draft.profileId]);
  if (!row) throw new Error("Taskset draft Model was not found in this Profile.");
  const model = ModelProjectSchema.parse(JSON.parse(row.payload));
  const tasksetRef = { id: taskset.id, revision: taskset.revision, contentHash: taskset.contentHash };
  return saveModelProjectInTransaction(db, {
    schemaVersion: "openpond.modelProjectSave.v1",
    operationId: `draft-publication:${contentHash({ draftId: draft.id, revision: draft.revision, scope, tasksetRef })}`,
    expectedRevision: scope.expectedModelRevision,
    project: ModelProjectEditableSchema.strip().parse({
      ...model,
      trainingSetup: {
        ...model.trainingSetup,
        tasksetRef,
        rewardBindingRef: taskset.metadata.rewardBinding === undefined ? null : ModelProjectVersionedRefSchema.parse(taskset.metadata.rewardBinding),
        tasksetRelease: null,
        recipe: null,
      },
    }),
  });
}
