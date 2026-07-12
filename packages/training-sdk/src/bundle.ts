import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  TrainingBundleManifestSchema,
  type Taskset,
  type TrainingBundleManifest,
  type TrainingPlan,
} from "@openpond/contracts";
import { canonicalJson, contentHash, sha256 } from "@openpond/taskset-sdk";

export async function buildTrainingBundle(input: { taskset: Taskset; plan: TrainingPlan; directory: string }): Promise<TrainingBundleManifest> {
  if (!input.plan.compatibility.compatible) throw new Error("Training Plan is incompatible and cannot be bundled.");
  if (!input.plan.dataPolicy.exportApproved) throw new Error("Training export approval is required before bundle creation.");
  if (input.taskset.contentHash !== input.plan.tasksetHash) throw new Error("Training Plan references a different Taskset hash.");
  const approved = new Set(input.plan.dataPolicy.approvedSourceIds);
  const trainTasks = input.taskset.tasks.filter((task) => task.split === "train" && task.sourceRefs.every((source) => approved.has(source))).map((task) => ({ id: task.id, input: task.input, expectedOutput: task.expectedOutput, tags: task.tags }));
  if (trainTasks.length === 0) throw new Error("Training Bundle has no approved training demonstrations.");
  await mkdir(input.directory, { recursive: true });
  const assets = [
    { path: "data/train.jsonl", role: "task_data" as const, content: trainTasks.map((task) => JSON.stringify(task)).join("\n") + "\n" },
    { path: "recipe.json", role: "recipe" as const, content: canonicalJson(input.plan.recipe) },
    { path: "policy.json", role: "policy" as const, content: canonicalJson({ tasksetId: input.taskset.id, tasksetHash: input.taskset.contentHash, sourceIds: input.plan.dataPolicy.approvedSourceIds, retentionDays: input.plan.dataPolicy.retentionDays, region: input.plan.dataPolicy.region }) },
    { path: "provenance.json", role: "provenance" as const, content: canonicalJson(input.taskset.authoringProvenance) },
  ];
  const files = [];
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
