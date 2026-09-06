import { createHash } from "node:crypto";
import {
  ModelProjectSchema,
  parseModelProjectSaveRequest,
  OpenPondModelProjectApiError,
  type ModelProject,
  type ModelProjectSaveRequest,
} from "openpond-sdk/model-projects";
import { canonicalJson } from "openpond-sdk/training";
import { TasksetSchema } from "@openpond/contracts";
import { assertLearningContentHash } from "@openpond/evals/learning";
import { RewardBindingSchema, RewardReleaseSchema } from "@openpond/evals/rewards";
import type { OpenPondSqliteConnection } from "./sqlite/sqlite-driver.js";

type PayloadRow = { payload: string };

export function findModelProjectSave(db: OpenPondSqliteConnection, value: ModelProjectSaveRequest): ModelProject | null {
  const request = parseModelProjectSaveRequest(value);
  const prior = db.get<PayloadRow & { request_hash: string }>(
    "SELECT request_hash, payload FROM model_project_save_operations WHERE profile_id = ? AND operation_id = ?",
    [request.project.profileId, request.operationId],
  );
  if (!prior) return null;
  const hash = createHash("sha256").update(canonicalJson(request)).digest("hex");
  if (prior.request_hash !== hash) fail(409, "model_operation_conflict", "This save operation was already used with different Model configuration.");
  return ModelProjectSchema.parse(JSON.parse(prior.payload));
}

/** Called inside the store's write queue; no await can split the SQLite transaction. */
export function commitModelProjectSave(db: OpenPondSqliteConnection, value: ModelProjectSaveRequest): ModelProject {
  db.exec("BEGIN IMMEDIATE");
  try {
    const saved = saveModelProjectInTransaction(db, value);
    db.exec("COMMIT");
    return saved;
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}

/** The caller owns the transaction and write queue. */
export function saveModelProjectInTransaction(db: OpenPondSqliteConnection, value: ModelProjectSaveRequest): ModelProject {
  const request = parseModelProjectSaveRequest(value);
  const hash = createHash("sha256").update(canonicalJson(request)).digest("hex");
  const { project, operationId, expectedRevision } = request;
  const prior = findModelProjectSave(db, request);
  if (prior) return prior;
  const row = db.get<PayloadRow>("SELECT payload FROM model_projects WHERE id = ?", [project.id]);
  const existing = row ? ModelProjectSchema.parse(JSON.parse(row.payload)) : null;
  if (existing && existing.profileId !== project.profileId) fail(404, "model_not_found", "Model is not available in this Profile.");
  if ((existing?.revision ?? 0) !== expectedRevision) fail(409, "model_revision_conflict", "Model changed since it was opened. Refresh before saving.");
  assertTaskset(db, request);
  assertReward(db, request);
  const timestamp = new Date().toISOString();
  const saved = ModelProjectSchema.parse({
    ...existing,
    ...project,
    schemaVersion: "openpond.modelProject.v2",
    revision: expectedRevision + 1,
    hosted: existing?.hosted ?? null,
    tasksetSyncs: existing?.tasksetSyncs ?? [],
    createdAt: existing?.createdAt ?? timestamp,
    updatedAt: timestamp,
  });
  db.run(`INSERT INTO model_projects (id, profile_id, payload, created_at, updated_at) VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET payload = excluded.payload, updated_at = excluded.updated_at`,
  [saved.id, saved.profileId, JSON.stringify(saved), saved.createdAt, saved.updatedAt]);
  db.run("INSERT INTO model_project_save_operations (profile_id, operation_id, request_hash, payload) VALUES (?, ?, ?, ?)",
    [saved.profileId, operationId, hash, JSON.stringify(saved)]);
  return saved;
}

function assertTaskset(db: OpenPondSqliteConnection, request: ModelProjectSaveRequest) {
  const reference = request.project.trainingSetup.tasksetRef;
  if (!reference) {
    if (request.project.trainingSetup.tasksetRelease) fail(400, "model_taskset_required", "Choose the Taskset corresponding to this release.");
    return;
  }
  const row = db.get<PayloadRow>("SELECT payload FROM taskset_revisions WHERE taskset_id = ? AND revision = ?", [reference.id, reference.revision]);
  const taskset = row ? TasksetSchema.parse(JSON.parse(row.payload)) : null;
  if (!taskset || taskset.profileId !== request.project.profileId) fail(404, "model_taskset_not_found", "The selected Taskset revision is not available in this Profile.");
  if (taskset.contentHash !== reference.contentHash) fail(409, "model_taskset_changed", "The selected Taskset does not match its immutable content hash.");
}

function assertReward(db: OpenPondSqliteConnection, request: ModelProjectSaveRequest) {
  const reference = request.project.trainingSetup.rewardBindingRef;
  if (!reference) return;
  function read(kind: "binding" | "reward", ref: { id: string; revision: number; contentHash: string }) {
    const row = db.get<PayloadRow>("SELECT payload FROM learning_revisions WHERE scope = ? AND kind = ? AND id = ? AND revision = ?", [request.project.profileId, kind, ref.id, ref.revision]);
    if (!row) fail(404, "model_reward_unavailable", "The exact Reward configuration is unavailable in this Profile.");
    const resource = (kind === "binding" ? RewardBindingSchema : RewardReleaseSchema).parse(JSON.parse(row.payload));
    if (resource.contentHash !== ref.contentHash) fail(409, "model_reward_changed", "The selected Reward does not match its immutable content hash.");
    assertLearningContentHash(resource);
    return resource;
  }
  const binding = RewardBindingSchema.parse(read("binding", reference));
  for (const source of binding.sources) read("reward", source.reward);
}

function fail(status: number, code: string, message: string): never {
  throw new OpenPondModelProjectApiError(status, {
    schemaVersion: "openpond.modelProjectApiError.v2", code, message,
    retryable: false, requestId: null, details: {},
  });
}
