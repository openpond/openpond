import { createHash } from "node:crypto";
import { learningRef } from "@openpond/evals/learning";
import { ModelProjectSchema, createModelProjectSaveRequest } from "openpond-sdk/model-projects";
import { parseModelStarterCreationRequest, validateResolvedModelStarter, type ModelStarterCreationRequest } from "openpond-sdk/model-starters";
import { canonicalJson } from "openpond-sdk/training";
import { prepareModelStarterTaskset } from "../training/model-starter-taskset.js";
import type { OpenPondSqliteConnection } from "./sqlite/sqlite-driver.js";
import { putLearningResourceInTransaction } from "./store-learning.js";
import { saveModelProjectInTransaction } from "./store-model-project-authoring.js";

export type ModelStarterCommitInput = Parameters<typeof prepareModelStarterTaskset>[0];

export function findModelStarterCreation(db: OpenPondSqliteConnection, value: ModelStarterCreationRequest) {
  const request = parseModelStarterCreationRequest(value);
  const row = db.get<{ request_hash: string; payload: string }>("SELECT request_hash, payload FROM model_starter_creation_operations WHERE profile_id = ? AND operation_id = ?", [request.profileId, request.operationId]);
  if (!row) return null;
  if (row.request_hash !== requestHash(request)) throw new Error("Starter creation operation was already used with different configuration.");
  return ModelProjectSchema.parse(JSON.parse(row.payload));
}

/** The store owns the write queue. Immutable package files must be materialized
 * before invoking this commit; no filesystem, network or training runs in it. */
export async function commitModelStarterCreation(db: OpenPondSqliteConnection, input: ModelStarterCommitInput) {
  const request = parseModelStarterCreationRequest(input.request);
  const previous = findModelStarterCreation(db, request);
  if (previous) return previous;
  const { taskset } = prepareModelStarterTaskset(input);
  const resolved = validateResolvedModelStarter(input.package);
  const modelRequest = await createModelProjectSaveRequest({
    id: request.modelId, profileId: request.profileId, name: request.name, objective: resolved.taskDefinition.instructions,
    defaultBaseModel: request.startingModel, defaultDestinationId: null,
    trainingSetup: { tasksetRef: learningRef(taskset), rewardBindingRef: learningRef(resolved.rewardBinding), baseModel: request.startingModel, method: request.method },
  }, 0);
  db.exec("BEGIN IMMEDIATE");
  try {
    const prior = findModelStarterCreation(db, request);
    if (prior) { db.exec("COMMIT"); return prior; }
    if (db.get("SELECT id FROM tasksets WHERE id = ?", [taskset.id]) || db.get("SELECT id FROM model_projects WHERE id = ?", [request.modelId])) throw new Error("Starter creation requires a new Model and Taskset identity.");
    const resources = [
      ...resolved.assets.map(resource => ({ kind: "asset" as const, resource })),
      ...resolved.rewards.map(resource => ({ kind: "reward" as const, resource })),
      { kind: "binding" as const, resource: resolved.rewardBinding },
      { kind: "definition" as const, resource: resolved.taskDefinition },
    ];
    for (const { kind, resource } of resources) {
      const existing = db.get<{ payload: string }>("SELECT payload FROM learning_revisions WHERE scope = ? AND kind = ? AND id = ? AND revision = ?", [request.profileId, kind, resource.id, resource.revision]);
      if (existing) {
        if (canonicalJson(JSON.parse(existing.payload)) !== canonicalJson(resource)) throw new Error(`Starter dependency conflicts with an existing revision: ${resource.id}.`);
        continue;
      }
      putLearningResourceInTransaction(db, request.profileId, kind, resource, resource.revision - 1);
    }
    const payload = JSON.stringify(taskset);
    db.run("INSERT INTO tasksets (id, profile_id, status, payload, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)", [taskset.id, taskset.profileId, taskset.status, payload, taskset.createdAt, taskset.updatedAt]);
    db.run("INSERT INTO taskset_revisions (taskset_id, revision, content_hash, profile_id, status, payload, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)", [taskset.id, taskset.revision, taskset.contentHash, taskset.profileId, taskset.status, payload, taskset.createdAt, taskset.updatedAt]);
    const saved = saveModelProjectInTransaction(db, modelRequest);
    db.run("INSERT INTO model_starter_creation_operations (profile_id, operation_id, request_hash, payload) VALUES (?, ?, ?, ?)", [request.profileId, request.operationId, requestHash(request), JSON.stringify(saved)]);
    db.exec("COMMIT");
    return saved;
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}

function requestHash(request: ModelStarterCreationRequest) { return createHash("sha256").update(canonicalJson(request)).digest("hex"); }
