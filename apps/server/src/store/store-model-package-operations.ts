import { z } from "zod";
import { ModelProjectSchema, ModelProjectVersionedRefSchema } from "openpond-sdk/model-projects";
import { TasksetPackagePublicationSchema, TasksetPackageReceiptSchema, type TasksetPackageReceipt } from "openpond-sdk/taskset-packages";
import { canonicalJson } from "openpond-sdk/training";
import type { OpenPondSqliteConnection } from "./sqlite/sqlite-driver.js";
import { commitModelProjectHosting } from "./store-model-project-hosting.js";
const { package: _package, evaluationPackage: _evaluationPackage, ...PublicationIntentShape } = TasksetPackagePublicationSchema.shape;

/** Files live in the immutable package cache. The durable intent contains no
 * credentials, and survives a lost response followed by further local edits. */
export const ModelPackageOperationSchema = z.object({
  apiOrigin: z.string().url().refine(value => new URL(value).origin === value),
  teamId: z.string().min(1), project: ModelProjectSchema,
  localTaskset: ModelProjectVersionedRefSchema,
  localEvaluation: ModelProjectVersionedRefSchema.optional(),
  evaluationPackageHash: z.string().regex(/^[a-f0-9]{64}$/).optional(),
  packageHash: z.string().regex(/^[a-f0-9]{64}$/),
  request: z.object(PublicationIntentShape).strict(),
}).strict().refine(value => Boolean(value.localEvaluation) === Boolean(value.evaluationPackageHash), "Evaluation bytes and local identity must be captured together.");
export type ModelPackageOperation = z.infer<typeof ModelPackageOperationSchema>;
export type ModelPackageScope = { profileId: string; modelId: string; apiOrigin: string; teamId: string };

export function pendingModelPackageOperation(db: OpenPondSqliteConnection, scope: ModelPackageScope): ModelPackageOperation | null {
  const row = db.get<{ payload: string }>("SELECT payload FROM model_project_package_operations WHERE profile_id = ? AND model_id = ? AND state = 'pending'", [scope.profileId, scope.modelId]);
  const pending = row ? ModelPackageOperationSchema.parse(JSON.parse(row.payload)) : null;
  if (pending && (pending.apiOrigin !== scope.apiOrigin || pending.teamId !== scope.teamId)) throw new Error("Finish the pending package publication in its original API and workspace before changing hosting.");
  return pending;
}

export function prepareModelPackageOperation(db: OpenPondSqliteConnection, input: ModelPackageOperation): ModelPackageOperation {
  const value = ModelPackageOperationSchema.parse(input);
  db.exec("BEGIN IMMEDIATE");
  try {
    const pending = pendingModelPackageOperation(db, { profileId: value.project.profileId, modelId: value.project.id, apiOrigin: value.apiOrigin, teamId: value.teamId });
    if (pending) { db.exec("COMMIT"); return pending; }
    const row = db.get<{ payload: string }>("SELECT payload FROM model_projects WHERE id = ?", [value.project.id]);
    const current = row ? ModelProjectSchema.parse(JSON.parse(row.payload)) : null;
    if (canonicalJson(current) !== canonicalJson(value.project)) throw new Error("Model changed while its package was being prepared. Retry the push.");
    const previous = db.get<{ payload: string; state: string }>("SELECT payload, state FROM model_project_package_operations WHERE operation_id = ?", [value.request.operationId]);
    if (previous) {
      const original = ModelPackageOperationSchema.parse(JSON.parse(previous.payload));
      if (canonicalJson({ ...original, project: value.project }) !== canonicalJson(value)) throw new Error("Package operation identity was reused with different publication content.");
      if (previous.state === "committed") { db.exec("COMMIT"); return original; }
      db.run("UPDATE model_project_package_operations SET state = 'pending', payload = ? WHERE operation_id = ? AND state = 'rejected'", [JSON.stringify(value), value.request.operationId]);
    } else db.run("INSERT INTO model_project_package_operations (operation_id, profile_id, model_id, api_origin, team_id, state, payload, created_at) VALUES (?, ?, ?, ?, ?, 'pending', ?, ?)", [value.request.operationId, value.project.profileId, value.project.id, value.apiOrigin, value.teamId, JSON.stringify(value), new Date().toISOString()]);
    db.exec("COMMIT");
    return value;
  } catch (error) { db.exec("ROLLBACK"); throw error; }
}

export function completeModelPackageOperation(db: OpenPondSqliteConnection, operationId: string, input: TasksetPackageReceipt) {
  const receipt = TasksetPackageReceiptSchema.parse(input);
  const row = db.get<{ payload: string; receipt: string | null }>("SELECT payload, receipt FROM model_project_package_operations WHERE operation_id = ?", [operationId]);
  if (!row) throw new Error("Package push has no durable local intent.");
  const operation = ModelPackageOperationSchema.parse(JSON.parse(row.payload));
  if (row.receipt && canonicalJson(JSON.parse(row.receipt)) !== canonicalJson(receipt)) throw new Error("Package push retry returned a different receipt.");
  if (receipt.operationId !== operationId || receipt.teamId !== operation.teamId || receipt.packageHash !== operation.packageHash || receipt.modelProjectId !== operation.request.modelProjectId) throw new Error("Package push receipt differs from its local intent.");
  if (operation.evaluationPackageHash && (!receipt.evaluation || receipt.evaluation.packageHash !== operation.evaluationPackageHash
    || canonicalJson(receipt.evaluation.taskset) !== canonicalJson(operation.request.modelConfiguration?.trainingSetup.evaluationTasksetRef))) throw new Error("Evaluation package receipt differs from its local intent.");
  const project = operation.project;
  const remote = receipt.project;
  if (operation.request.selection === "select" && !remote) throw new Error("Selected package receipt is missing Model configuration.");
  if (!remote && !project.hosted) throw new Error("Historical package receipt has no existing hosted Model.");
  const now = new Date().toISOString();
  const next = ModelProjectSchema.parse({ ...project, hosted: {
    schemaVersion: "openpond.hostedModelProjectLink.v1", apiOrigin: operation.apiOrigin, teamId: operation.teamId,
    projectId: remote?.id ?? project.hosted!.projectId, portableProjectId: project.id,
    revision: remote?.revision ?? project.hosted!.revision, etag: receipt.projectEtag,
    syncedSourceRevision: operation.request.selection === "select" ? project.revision : project.hosted!.syncedSourceRevision,
    syncedAt: now, tasksets: [...(project.hosted?.tasksets ?? []).filter(link => link.releaseHash !== receipt.taskset.contentHash && link.releaseHash !== receipt.evaluation?.taskset.contentHash), {
      localTasksetId: operation.localTaskset.id, localTasksetHash: operation.localTaskset.contentHash,
      releaseId: receipt.taskset.id, releaseRevision: receipt.taskset.revision, releaseHash: receipt.taskset.contentHash,
      packageHash: receipt.packageHash, hostedTasksetId: receipt.hostedTasksetId, syncedAt: now,
    }, ...(operation.localEvaluation && receipt.evaluation ? [{
      localTasksetId: operation.localEvaluation.id, localTasksetHash: operation.localEvaluation.contentHash,
      releaseId: receipt.evaluation.taskset.id, releaseRevision: receipt.evaluation.taskset.revision, releaseHash: receipt.evaluation.taskset.contentHash,
      packageHash: receipt.evaluation.packageHash, hostedTasksetId: receipt.evaluation.hostedTasksetId, syncedAt: now,
    }] : [])],
  }, tasksetSyncs: [
    ...project.tasksetSyncs.filter(link => link.localTasksetId !== operation.localTaskset.id && link.localTasksetId !== operation.localEvaluation?.id),
    { localTasksetId: operation.localTaskset.id, releaseId: receipt.taskset.id, releaseRevision: receipt.taskset.revision,
      releaseHash: receipt.taskset.contentHash, state: "synced", hostedTasksetId: receipt.hostedTasksetId,
      lastAttemptAt: now, syncedAt: now, lastError: null },
    ...(operation.localEvaluation && receipt.evaluation ? [{ localTasksetId: operation.localEvaluation.id,
      releaseId: receipt.evaluation.taskset.id, releaseRevision: receipt.evaluation.taskset.revision, releaseHash: receipt.evaluation.taskset.contentHash,
      state: "synced" as const, hostedTasksetId: receipt.evaluation.hostedTasksetId, lastAttemptAt: now, syncedAt: now, lastError: null }] : []),
  ] });
  return commitModelProjectHosting(db, project, next, false, () => {
    db.run("UPDATE model_project_package_operations SET state = 'committed', receipt = ? WHERE operation_id = ?", [JSON.stringify(receipt), operationId]);
  });
}
