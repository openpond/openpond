import path from "node:path";
import { mkdir, writeFile } from "node:fs/promises";
import { z } from "zod";
import type { Taskset } from "@openpond/contracts";
import { prepareReviewedLearningBatch } from "openpond-sdk/training-bundle";
import { learningRef, requireLearningRelease, requireLearningResource } from "@openpond/evals/learning";
import { contentHash } from "@openpond/harness";
import { buildTaskset } from "@openpond/taskset-sdk";
import type { SqliteStore } from "../store/store.js";
import { buildTasksetReadiness } from "./readiness.js";
import { readCachedTasksetPackage } from "./taskset-package-files.js";
import { decodeTasksetPackageFile } from "openpond-sdk/taskset-packages";

const PrepareLearningBatchSchema = z.object({ profileId: z.string().trim().min(1).max(240), batchId: z.string().trim().min(1).max(240) }).strict();

export async function prepareLocalLearningBatch(store: SqliteStore, storeDir: string, raw: unknown) {
  const input = PrepareLearningBatchSchema.parse(raw);
  const snapshot = await store.learningRepository().transaction(input.profileId, async (transaction) => {
    const batch = await requireLearningResource(transaction, "batch", input.batchId);
    const definition = await requireLearningRelease(transaction, "definition", batch.taskDefinition);
    const binding = await requireLearningRelease(transaction, "binding", batch.rewardBinding);
    const rewardRefs = [...new Map(binding.sources.map(source => [
      `${source.reward.id}:${source.reward.revision}:${source.reward.contentHash}`, source.reward,
    ])).values()];
    const rewards = await Promise.all(rewardRefs.map(reference => requireLearningRelease(transaction, "reward", reference)));
    const evidence = await Promise.all(batch.examples.map((entry) => requireLearningRelease(transaction, "evidence", entry.evidence)));
    const decisions = await Promise.all(batch.examples.map((entry) => requireLearningRelease(transaction, "decision", entry.decision)));
    const assetIds = new Set(rewards.flatMap((reward) => [
      ...reward.assets.map((asset) => asset.id),
      ...(reward.implementation.kind === "custom_verifier" ? [reward.implementation.verifierRef.id]
        : reward.implementation.kind === "model_judge" || reward.implementation.kind === "human" ? [reward.implementation.rubricRef.id] : []),
    ]));
    const assets = await Promise.all([...assetIds].map((id) => requireLearningResource(transaction, "asset", id, 1)));
    const inputAssets = await Promise.all([...new Set(evidence.flatMap(item => item.submission.assets.map(asset => asset.id)))].map(id => transaction.get("asset", id, 1)));
    const sources = await Promise.all([...new Map(evidence.map(item => [contentHash(item.source), item.source])).values()].map(ref => requireLearningRelease(transaction, "source", ref)));
    return { batch, definition, binding, rewards, evidence, decisions, assets, inputAssets, sources };
  });
  const existingId = `learning-${contentHash([input.profileId, snapshot.batch.contentHash]).slice(0, 40)}`;
  const existing = await store.getTaskset(existingId);
  if (existing) {
    if (existing.profileId !== input.profileId) throw new Error("Learning batch Taskset belongs to a different profile.");
    return ensureReadiness(existing);
  }
  const assetBytes = new Map<string, Uint8Array>();
  for (const asset of snapshot.inputAssets) if (asset) assetBytes.set(asset.id, new TextEncoder().encode(asset.text));
  const sourcePackages = snapshot.sources.filter(source => source.reviewOrigin && snapshot.evidence.some(item =>
    contentHash(item.source) === contentHash(learningRef(source))
    && item.submission.assets.some(asset => !assetBytes.has(asset.id))));
  for (const hash of new Set(sourcePackages.map(source => source.reviewOrigin!.packageHash))) {
    const parent = await readCachedTasksetPackage(storeDir, hash);
    for (const file of parent.files) {
      if (!snapshot.evidence.some(item => item.submission.assets.some(asset => asset.id === file.asset.id && asset.contentHash === file.asset.contentHash))) continue;
      const bytes = decodeTasksetPackageFile(file);
      const previous = assetBytes.get(file.asset.id);
      if (previous && !Buffer.from(previous).equals(bytes)) throw new Error("Learning input has conflicting immutable bytes.");
      assetBytes.set(file.asset.id, bytes);
    }
  }
  const { taskset, release, generatedFiles, tasksetAssetBytes } = prepareReviewedLearningBatch({ ...snapshot, assetBytes, profileId: input.profileId });
  const directory = path.join(storeDir, "training", "tasksets", taskset.id);
  await buildTaskset(taskset, directory, { generatedFiles });
  for (const [relative, bytes] of tasksetAssetBytes) {
    const destination = path.join(directory, relative);
    await mkdir(path.dirname(destination), { recursive: true });
    await writeFile(destination, bytes, { mode: 0o600 });
  }
  await writeFile(path.join(directory, "learning-taskset.release.json"), JSON.stringify(release), { encoding: "utf8", mode: 0o600 });
  return ensureReadiness(taskset);

  async function ensureReadiness(taskset: Taskset) {
    if (taskset.readiness?.tasksetHash === taskset.contentHash) return taskset;
    const readiness = buildTasksetReadiness({ taskset });
    await store.saveReadinessReport(readiness);
    return store.upsertTaskset({ ...taskset, status: readiness.ready ? "ready" : "needs_review", readiness });
  }
}
