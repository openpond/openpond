import { readFile } from "node:fs/promises";
import path from "node:path";
import { HarnessRunManifestSchema, type Taskset, type TrainingPlan, type TaskDataRecord } from "@openpond/contracts";
import { contentHash, sha256 } from "@openpond/taskset-sdk";
import { verifyResolvedTrainingBundle } from "@openpond/training-sdk";
import { TRAINING_EVALUATION_SOURCE_PATH, TrainingEvaluationSourceSchema, trainingEvaluationSourceRef, type TrainingExecutionReceipt } from "openpond-sdk/training";
import type { SqliteStore } from "../store/store.js";
import { resolveManagedValidationTaskSource } from "./managed-training-validation-tasks.js";
import { resolveTasksetEvaluationAssetBytes } from "./taskset-work-assets.js";

export async function buildManagedTrainingEvaluationSource(input: {
  store: SqliteStore;
  storeDir: string;
  trainingPlan: Pick<TrainingPlan, "comparisonSeriesEntry" | "evaluationTasksetRef">;
  trainingTaskset: Taskset;
}) {
  const selection = await resolveManagedValidationTaskSource(input);
  const bytes = selection.taskset.environment.kind === "work"
    ? await resolveTasksetEvaluationAssetBytes({ storeDir: input.storeDir, taskset: selection.taskset })
    : new Map<string, Uint8Array>();
  if (selection.taskset.environment.kind !== "work" && selection.tasks.some(task => task.assets?.length)) {
    throw new Error("The selected held-out task files require an additional managed execution adapter.");
  }
  return TrainingEvaluationSourceSchema.parse({
    schemaVersion: "openpond.trainingEvaluationSource.v1",
    taskset: { id: selection.taskset.id, revision: selection.taskset.revision, contentHash: selection.taskset.contentHash },
    tasks: selection.tasks,
    assets: [...bytes.entries()].sort(([left], [right]) => left.localeCompare(right)).map(([path, value]) => ({
      path, sha256: sha256(value), sizeBytes: value.byteLength, encoding: "base64", content: Buffer.from(value).toString("base64"),
    })),
  });
}

/** Receipt collection must use the submitted bundle, never current settings. */
export async function loadManagedTrainingEvaluationSource(storeDir: string, manifestHash: string) {
  if (!/^[a-f0-9]{64}$/.test(manifestHash)) throw new Error("The managed evaluation manifest identity is missing.");
  const root = path.join(storeDir, "training", "portable-releases");
  const manifest = HarnessRunManifestSchema.parse(JSON.parse(await readFile(path.join(root, "manifests", `${manifestHash}.json`), "utf8")));
  const { contentHash: hash, ...content } = manifest;
  if (hash !== manifestHash || contentHash(content) !== hash) throw new Error("The managed evaluation manifest changed.");
  const directory = path.join(root, "resolved-bundles", manifest.resolvedBundleHash);
  const bundle = await verifyResolvedTrainingBundle(directory);
  if (bundle.contentHash !== manifest.resolvedBundleHash) throw new Error("The managed evaluation bundle changed.");
  const entry = bundle.files.find(file => file.path === TRAINING_EVALUATION_SOURCE_PATH);
  if (!entry) throw new Error("The managed run has no pinned evaluation source.");
  const bytes = await readFile(path.join(directory, TRAINING_EVALUATION_SOURCE_PATH));
  if (sha256(bytes) !== entry.sha256 || bytes.byteLength !== entry.sizeBytes) throw new Error("The managed evaluation source changed.");
  return TrainingEvaluationSourceSchema.parse(JSON.parse(bytes.toString("utf8")));
}

export async function assertManagedTrainingEvaluationReceipt(input: {
  storeDir: string;
  expectedManifestHash: string | undefined;
  expectedSubmissionHash: string | undefined;
  receipt: TrainingExecutionReceipt;
}) {
  const { receipt } = input;
  if (receipt.manifestHash !== input.expectedManifestHash || receipt.submissionHash !== input.expectedSubmissionHash) {
    throw new Error("The managed receipt differs from the submitted manifest or Job inputs.");
  }
  const evaluation = await trainingEvaluationSourceRef(await loadManagedTrainingEvaluationSource(input.storeDir, receipt.manifestHash));
  for (const expected of [evaluation.taskset, evaluation.dataset]) {
    if (!receipt.inputs.some(value => value.id === expected.id && value.contentHash === expected.contentHash)) {
      throw new Error("The managed receipt does not retain the pinned evaluation source.");
    }
  }
}

/** The caller has already verified these files against the resolved manifest. */
export async function resolvePreparedManagedTrainingEvaluationSource(
  files: ReadonlyArray<{ path: string; content: string }>,
  expectedTaskset: TrainingPlan["evaluationTasksetRef"],
  expectedTasks: TaskDataRecord[],
) {
  const file = files.find(value => value.path === TRAINING_EVALUATION_SOURCE_PATH);
  if (!file) throw new Error("Managed training is missing its pinned evaluation source.");
  const source = TrainingEvaluationSourceSchema.parse(JSON.parse(Buffer.from(file.content, "base64").toString("utf8")));
  if (contentHash(source.taskset) !== contentHash(expectedTaskset)
    || contentHash(source.tasks) !== contentHash(expectedTasks)) {
    throw new Error("The evaluation bundle differs from the approved held-out Taskset.");
  }
  return { source, reference: await trainingEvaluationSourceRef(source) };
}
