import { LearningDomainError, sameLearningRef, taskBatchPackageMetadata } from "@openpond/evals/learning";
import { TasksetSchema } from "@openpond/contracts";
import { contentHash } from "@openpond/harness";
import { ModelProjectSchema } from "openpond-sdk/model-projects";
import { beginModelBatchReview, findModelBatchReview, ModelBatchReviewRequestSchema, type ModelBatchReviewRequest, type TasksetPackage } from "openpond-sdk/taskset-packages";
import { SqliteTasksetDraftStore } from "./store-taskset-drafts.js";
import { createLearningTransaction } from "./store-learning.js";

/** Review creation and Model edits serialize on the same SQLite write queue. */
export class SqliteModelBatchReviewStore extends SqliteTasksetDraftStore {
  async findModelBatchReview(scope: string, raw: ModelBatchReviewRequest) {
    return this.modelBatchReviewTransaction(scope, raw);
  }

  async beginModelBatchReview(scope: string, raw: ModelBatchReviewRequest, value: TasksetPackage) {
    const result = await this.modelBatchReviewTransaction(scope, raw, value);
    if (!result) throw new Error("Model batch review was not created.");
    return result;
  }

  private async modelBatchReviewTransaction(scope: string, raw: ModelBatchReviewRequest, value?: TasksetPackage) {
    const request = ModelBatchReviewRequestSchema.parse(raw);
    await this.ready;
    const operation = this.writeQueue.then(async () => {
      const db = this.db;
      if (!db) throw new Error("Model review store is closed.");
      db.exec("BEGIN IMMEDIATE");
      let open = true;
      const transaction = createLearningTransaction(db, scope, () => { if (!open) throw new Error("Model review transaction is closed."); });
      try {
        const row = db.get<{ payload: string }>("SELECT payload FROM model_projects WHERE id = ? AND profile_id = ?", [request.modelId, scope]);
        if (!row) throw new LearningDomainError("model_not_found", 404);
        const model = ModelProjectSchema.parse(JSON.parse(row.payload));
        const prior = await findModelBatchReview(transaction, request);
        if (prior || !value) { db.exec("COMMIT"); return prior; }
        if (model.revision !== request.expectedModelRevision || !model.trainingSetup.tasksetRef
          || !sameLearningRef(model.trainingSetup.tasksetRef, request.tasksetRef)) throw new LearningDomainError("model_revision_conflict", 409);
        const selected = db.get<{ payload: string }>("SELECT payload FROM taskset_revisions WHERE taskset_id = ? AND revision = ? AND profile_id = ?", [request.tasksetRef.id, request.tasksetRef.revision, scope]);
        const taskset = selected ? TasksetSchema.parse(JSON.parse(selected.payload)) : null;
        if (!taskset || taskset.contentHash !== request.tasksetRef.contentHash
          || contentHash(taskset.metadata.learning) !== contentHash(taskBatchPackageMetadata(value.taskset))) throw new LearningDomainError("model_review_package_mismatch", 409);
        const result = await beginModelBatchReview(transaction, { scope, request, package: value, now: new Date().toISOString() });
        db.exec("COMMIT");
        return result;
      } catch (error) { db.exec("ROLLBACK"); throw error; }
      finally { open = false; }
    });
    this.writeQueue = operation.then(() => undefined, () => undefined);
    return operation;
  }
}
