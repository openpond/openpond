import path from "node:path";
import { writeFile } from "node:fs/promises";
import { z } from "zod";
import type { Taskset } from "@openpond/contracts";
import { prepareReviewedLearningBatch } from "openpond-sdk/training-bundle";
import { requireLearningRelease, requireLearningResource } from "@openpond/evals/learning";
import { contentHash } from "@openpond/harness";
import { buildTaskset } from "@openpond/taskset-sdk";
import type { SqliteStore } from "../store/store.js";
import { buildTasksetReadiness } from "./readiness.js";

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
    return { batch, definition, binding, rewards, evidence, decisions, assets };
  });
  const existingId = `learning-${contentHash([input.profileId, snapshot.batch.contentHash]).slice(0, 40)}`;
  const existing = await store.getTaskset(existingId);
  if (existing) {
    if (existing.profileId !== input.profileId) throw new Error("Learning batch Taskset belongs to a different profile.");
    return ensureReadiness(existing);
  }
  const { taskset, release, generatedFiles } = prepareReviewedLearningBatch({ ...snapshot, profileId: input.profileId });
  const directory = path.join(storeDir, "training", "tasksets", taskset.id);
  await buildTaskset(taskset, directory, { generatedFiles });
  await writeFile(path.join(directory, "learning-taskset.release.json"), JSON.stringify(release), { encoding: "utf8", mode: 0o600 });
  return ensureReadiness(taskset);

  async function ensureReadiness(taskset: Taskset) {
    if (taskset.readiness?.tasksetHash === taskset.contentHash) return taskset;
    const readiness = buildTasksetReadiness({ taskset });
    await store.saveReadinessReport(readiness);
    return store.upsertTaskset({ ...taskset, status: readiness.ready ? "ready" : "needs_review", readiness });
  }
}
