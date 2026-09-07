import path from "node:path";
import { constants } from "node:fs";
import { open, realpath } from "node:fs/promises";
import { z } from "zod";
import type { TaskAttemptResult, TaskDataRecord, Taskset } from "@openpond/contracts";
import { learningRef } from "@openpond/evals/learning";
import { ModelProjectVersionedRefSchema } from "openpond-sdk/model-projects";
import { ModelStarterEnvironmentAttemptSchema } from "openpond-sdk/model-starters";
import { contentHash, sha256 } from "@openpond/taskset-sdk";
import type { SqliteStore } from "../store/store.js";
import { loadStarterToolEnvironment } from "./starter-tool-environment.js";

const HashSchema = z.string().regex(/^[a-f0-9]{64}$/);
const EnvelopeSchema = z.object({
  schemaVersion: z.literal("openpond.starterToolAttempt.v1"), requestId: z.string(),
  taskset: ModelProjectVersionedRefSchema, taskHash: HashSchema, model: z.unknown(),
  seed: z.number().int(), attempt: z.number().int(), definition: ModelProjectVersionedRefSchema,
  policySource: z.enum(["model", "fixture"]),
  environment: ModelProjectVersionedRefSchema, verifierSet: ModelProjectVersionedRefSchema,
  result: ModelStarterEnvironmentAttemptSchema,
}).strict();

/** Manual output/evaluatorContext cannot manufacture this store-owned evidence. */
export async function readStarterToolEvidence(input: {
  store: SqliteStore; storeDir: string; taskset: Taskset; task: TaskDataRecord; attempt: TaskAttemptResult;
}): Promise<Record<string, unknown>> {
  const { store, taskset, task, attempt } = input;
  const resolved = await loadStarterToolEnvironment(store, taskset, task);
  const records = await store.listTaskAttemptArtifacts({ attemptId: attempt.id });
  const candidates = records.filter(artifact => artifact.kind === "environment_state" && artifact.tasksetId === taskset.id && artifact.taskId === task.id && artifact.attemptId === attempt.id && attempt.artifactRefs.includes(artifact.id) && attempt.privilegedOutcomeRef === artifact.id);
  if (candidates.length !== 1) throw new Error("Tool grading requires exactly one owner-recorded environment artifact.");
  const artifact = candidates[0]!;
  const root = await realpath(path.join(input.storeDir, "training", "evaluation-artifacts"));
  const parent = await realpath(path.dirname(artifact.path));
  const relative = path.relative(root, parent);
  if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) throw new Error("Tool evidence is outside the execution owner's artifact directory.");
  const handle = await open(artifact.path, constants.O_RDONLY | constants.O_NOFOLLOW);
  let bytes: Buffer;
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.size > 33_554_432 || stat.size !== artifact.sizeBytes) throw new Error("Tool evidence exceeds its declared byte boundary.");
    bytes = await handle.readFile();
  } finally { await handle.close(); }
  if (bytes.byteLength !== artifact.sizeBytes || sha256(bytes) !== artifact.sha256) throw new Error("Owner-recorded tool evidence bytes changed.");
  const envelope = EnvelopeSchema.parse(JSON.parse(bytes.toString("utf8")));
  const { contentHash: resultHash, ...resultContent } = envelope.result;
  const result = envelope.result;
  if (contentHash(resultContent) !== resultHash || !result.snapshot || !result.environmentCleanupComplete ||
      !["completed", "budget_exhausted", "policy_failure"].includes(result.status) ||
      contentHash(envelope.taskset) !== contentHash(learningRef(taskset)) || envelope.taskHash !== contentHash(task) ||
      contentHash(envelope.model) !== contentHash(attempt.modelRef) || envelope.seed !== attempt.seed || envelope.attempt !== attempt.attempt ||
      attempt.tasksetId !== taskset.id || attempt.taskId !== task.id || attempt.split !== task.split ||
      contentHash(envelope.definition) !== contentHash(resolved.definition) ||
      contentHash(envelope.environment) !== contentHash(learningRef(resolved.execution.environment)) ||
      contentHash(envelope.verifierSet) !== contentHash(learningRef(resolved.execution.verifierSet)) ||
      result.taskId !== task.id || result.snapshot.seed !== attempt.seed || result.snapshot.inputHash !== contentHash(task.input) ||
      contentHash(result.snapshot.definition) !== contentHash(learningRef(resolved.execution.javascript)) ||
      result.snapshot.finalStateHash !== contentHash(result.snapshot.state) ||
      contentHash(attempt.output) !== contentHash({ text: result.output ?? "" }) ||
      attempt.metadata.environmentAttemptHash !== resultHash) {
    throw new Error("Tool evidence differs from the selected task, model or recorded attempt.");
  }
  if (attempt.metadata.policySource !== envelope.policySource) throw new Error("Tool evidence policy source changed.");
  return { environment: { status: result.status, collected: result.collected, definition: result.snapshot.definition, initialStateHash: result.snapshot.initialStateHash, finalStateHash: result.snapshot.finalStateHash, finalState: result.snapshot.state, events: result.snapshot.events } };
}
