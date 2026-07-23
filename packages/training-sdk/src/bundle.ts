import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import {
  copyFile,
  mkdir,
  readFile,
  stat,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import {
  TrainingBundleManifestSchema,
  type DatasetSelectionStrategy,
  type Taskset,
  type TrainingBundleManifest,
  type TrainingPlan,
} from "@openpond/contracts";
import { canonicalJson, contentHash, sha256 } from "@openpond/taskset-sdk";

export type ProjectedTrainingData = {
  path: string;
  contentHash: string;
  sizeBytes: number;
  exampleCount: number;
  eligibleRows: number;
  selectionSeed: number;
  selectionStrategy: DatasetSelectionStrategy;
  taskIdsHash: string;
};

type ResolvedTrainingData = Omit<ProjectedTrainingData, "path"> & (
  | { sourcePath: string }
  | { content: string }
);

export async function buildTrainingBundle(input: {
  taskset: Taskset;
  plan: TrainingPlan;
  directory: string;
  projectedTrainingData?: ProjectedTrainingData | null;
}): Promise<TrainingBundleManifest> {
  if (!input.plan.compatibility.compatible) throw new Error("Training Plan is incompatible and cannot be bundled.");
  if (!input.plan.dataPolicy.exportApproved) throw new Error("Training export approval is required before bundle creation.");
  if (input.taskset.contentHash !== input.plan.tasksetHash) throw new Error("Training Plan references a different Taskset hash.");
  const approved = new Set(input.plan.dataPolicy.approvedSourceIds);
  const taskData: ResolvedTrainingData = input.projectedTrainingData
    ? {
        ...input.projectedTrainingData,
        sourcePath: input.projectedTrainingData.path,
      }
    : inlineTrainingData(input.taskset, input.plan, approved);
  if (taskData.exampleCount === 0) throw new Error("Training Bundle has no approved training examples.");
  await mkdir(input.directory, { recursive: true });
  const assets = [
    { path: "recipe.json", role: "recipe" as const, content: canonicalJson(input.plan.recipe) },
    {
      path: "policy.json",
      role: "policy" as const,
      content: canonicalJson({
        tasksetId: input.taskset.id,
        tasksetHash: input.taskset.contentHash,
        sourceIds: input.plan.dataPolicy.approvedSourceIds,
        retentionDays: input.plan.dataPolicy.retentionDays,
        region: input.plan.dataPolicy.region,
        trainingData: {
          exampleCount: taskData.exampleCount,
          eligibleRows: taskData.eligibleRows,
          selectionSeed: taskData.selectionSeed,
          selectionStrategy: taskData.selectionStrategy,
          taskIdsHash: taskData.taskIdsHash,
        },
      }),
    },
    { path: "provenance.json", role: "provenance" as const, content: canonicalJson(input.taskset.authoringProvenance) },
  ];
  const files: TrainingBundleManifest["files"] = [{
    path: "data/train.jsonl",
    sha256: taskData.contentHash,
    sizeBytes: taskData.sizeBytes,
    role: "task_data" as const,
  }];
  const taskDataDestination = path.join(input.directory, "data/train.jsonl");
  await mkdir(path.dirname(taskDataDestination), { recursive: true });
  if ("sourcePath" in taskData) {
    await copyFile(taskData.sourcePath, taskDataDestination);
  } else {
    await writeFile(taskDataDestination, taskData.content, {
      encoding: "utf8",
      mode: 0o600,
    });
  }
  const copied = await fileIdentity(taskDataDestination);
  if (
    copied.contentHash !== taskData.contentHash
    || copied.sizeBytes !== taskData.sizeBytes
  ) {
    throw new Error("Projected training data changed while the Bundle was created.");
  }
  for (const asset of assets) {
    const destination = path.join(input.directory, asset.path);
    await mkdir(path.dirname(destination), { recursive: true });
    await writeFile(destination, asset.content, "utf8");
    files.push({ path: asset.path, sha256: sha256(asset.content), sizeBytes: Buffer.byteLength(asset.content), role: asset.role });
  }
  const createdAt = new Date().toISOString();
  const base = { schemaVersion: "openpond.trainingBundle.v1" as const, id: `training_bundle_${contentHash([input.plan.contentHash, files]).slice(0, 24)}`, planId: input.plan.id, tasksetId: input.taskset.id, tasksetHash: input.taskset.contentHash, recipeHash: contentHash(input.plan.recipe), files: [{ path: "manifest.json", sha256: "00000000", sizeBytes: 0, role: "manifest" as const }, ...files], totalSizeBytes: files.reduce((sum, file) => sum + file.sizeBytes, 0), sourceIds: input.plan.dataPolicy.approvedSourceIds, excludedSourceIds: input.taskset.sourceRefs.map((source) => source.id).filter((id) => !approved.has(id)), containsRawChats: false as const, containsSecrets: false as const, containsHiddenGraderAssets: false as const, createdAt, contentHash: "00000000" };
  const provisional = TrainingBundleManifestSchema.parse(base);
  const manifestHash = contentHash({ ...provisional, contentHash: "", files: provisional.files.map((file) => file.path === "manifest.json" ? { ...file, sha256: "", sizeBytes: 0 } : file) });
  const manifest = TrainingBundleManifestSchema.parse({ ...provisional, contentHash: manifestHash, files: provisional.files.map((file) => file.path === "manifest.json" ? { ...file, sha256: manifestHash, sizeBytes: 0 } : file) });
  await writeFile(path.join(input.directory, "manifest.json"), canonicalJson(manifest), "utf8");
  return manifest;
}

function inlineTrainingData(
  taskset: Taskset,
  plan: TrainingPlan,
  approvedSources: Set<string>,
): ResolvedTrainingData {
  if (
    plan.recipe.method !== "sft"
    && plan.recipe.method !== "dpo"
    && plan.recipe.method !== "grpo"
    && plan.recipe.method !== "ppo"
  ) {
    throw new Error(`Training method ${plan.recipe.method} cannot produce task data.`);
  }
  const approvedDemonstrations = new Set(
    taskset.learningSignals.demonstrations.flatMap((signal) =>
      signal.approved && signal.taskId ? [signal.taskId] : []),
  );
  const seed = plan.recipe.method === "grpo"
    ? plan.recipe.rollout.seed
    : plan.recipe.method === "ppo"
      ? plan.recipe.policyOptimization.seed
    : plan.recipe.optimizer.seed;
  if (plan.recipe.method === "dpo") {
    const selected = taskset.learningSignals.preferences
      .filter((signal) =>
        signal.approved
        && signal.sourceRefs.every((source) => approvedSources.has(source)))
      .map((signal) => ({
        priority: contentHash([
          taskset.contentHash,
          seed,
          "preference",
          signal.id,
        ]),
        record: {
          id: signal.id,
          prompt: signal.prompt,
          chosen: signal.chosen,
          rejected: signal.rejected,
          sourceRefs: signal.sourceRefs,
        },
      }))
      .sort((left, right) =>
        left.priority.localeCompare(right.priority)
        || left.record.id.localeCompare(right.record.id))
      .slice(0, plan.recipe.dataset.maxPairs);
    const content = selected.length
      ? `${selected.map((item) => JSON.stringify(item.record)).join("\n")}\n`
      : "";
    const bytes = Buffer.from(content, "utf8");
    return {
      content,
      contentHash: sha256(bytes),
      sizeBytes: bytes.byteLength,
      exampleCount: selected.length,
      eligibleRows: selected.length,
      selectionSeed: seed,
      selectionStrategy: plan.recipe.dataset.selectionStrategy,
      taskIdsHash: contentHash(selected.map((item) => item.record.id)),
    };
  }
  const limit = plan.recipe.method === "ppo"
    ? plan.recipe.policyOptimization.dataset.maxExamples
    : plan.recipe.dataset.maxExamples;
  const selected = taskset.tasks
    .filter((task) =>
      task.split === "train"
      && task.sourceRefs.every((source) => approvedSources.has(source))
      && (
        plan.recipe.method === "grpo"
        || plan.recipe.method === "ppo"
        || (
          task.expectedOutput !== null
          && approvedDemonstrations.has(task.id)
        )
      ))
    .map((task) => ({
      priority: contentHash([taskset.contentHash, seed, "train", task.id]),
      record: plan.recipe.method === "grpo" || plan.recipe.method === "ppo"
        ? { id: task.id, input: task.input, tags: task.tags }
        : {
            id: task.id,
            input: task.input,
            expectedOutput: task.expectedOutput,
            tags: task.tags,
          },
    }))
    .sort((left, right) =>
      left.priority.localeCompare(right.priority)
      || left.record.id.localeCompare(right.record.id))
    .slice(0, limit);
  const content = selected.length
    ? `${selected.map((item) => JSON.stringify(item.record)).join("\n")}\n`
    : "";
  const bytes = Buffer.from(content, "utf8");
  return {
    content,
    contentHash: sha256(bytes),
    sizeBytes: bytes.byteLength,
    exampleCount: selected.length,
    eligibleRows: selected.length,
    selectionSeed: seed,
    selectionStrategy: plan.recipe.method === "ppo"
      ? plan.recipe.policyOptimization.dataset.selectionStrategy
      : "stable_hash_top_n",
    taskIdsHash: contentHash(selected.map((item) => item.record.id)),
  };
}

async function fileIdentity(
  filePath: string,
): Promise<{ contentHash: string; sizeBytes: number }> {
  const digest = createHash("sha256");
  for await (const chunk of createReadStream(filePath)) {
    digest.update(chunk);
  }
  return {
    contentHash: digest.digest("hex"),
    sizeBytes: (await stat(filePath)).size,
  };
}

export async function inspectTrainingBundle(directory: string): Promise<TrainingBundleManifest> {
  return TrainingBundleManifestSchema.parse(JSON.parse(await readFile(path.join(directory, "manifest.json"), "utf8")));
}

export async function validateTrainingBundle(directory: string): Promise<{ valid: boolean; issues: string[]; manifest: TrainingBundleManifest }> {
  const manifest = await inspectTrainingBundle(directory);
  const issues: string[] = [];
  for (const file of manifest.files) {
    if (file.path === "manifest.json") continue;
    try {
      const bytes = await readFile(path.join(directory, file.path));
      if (sha256(bytes) !== file.sha256) issues.push(`${file.path}: hash mismatch`);
      if (bytes.byteLength !== file.sizeBytes) issues.push(`${file.path}: size mismatch`);
    } catch { issues.push(`${file.path}: missing`); }
  }
  if (manifest.containsRawChats || manifest.containsSecrets || manifest.containsHiddenGraderAssets) issues.push("Bundle privacy flags are unsafe.");
  return { valid: issues.length === 0, issues, manifest };
}
