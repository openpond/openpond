import path from "node:path";
import { writeFile } from "node:fs/promises";
import { z } from "zod";
import { LearningBatchDatasetSourceRefSchema, type Taskset } from "@openpond/contracts";
import { requireLearningRelease, requireLearningResource, learningRef } from "@openpond/evals/learning";
import { contentHash } from "@openpond/harness";
import { buildTaskset, materializeLearningBatchTaskset } from "@openpond/taskset-sdk";
import type { SqliteStore } from "../store/store.js";
import { scanAndRedactEvidence } from "./privacy.js";
import { buildTasksetReadiness } from "./readiness.js";

const PrepareLearningBatchSchema = z.object({ profileId: z.string().trim().min(1).max(240), batchId: z.string().trim().min(1).max(240) }).strict();

export async function prepareLocalLearningBatch(store: SqliteStore, storeDir: string, raw: unknown) {
  const input = PrepareLearningBatchSchema.parse(raw);
  const snapshot = await store.learningRepository().transaction(input.profileId, async (transaction) => {
    const batch = await requireLearningResource(transaction, "batch", input.batchId);
    const definition = await requireLearningRelease(transaction, "definition", batch.taskDefinition);
    const binding = await requireLearningRelease(transaction, "binding", batch.rewardBinding);
    const rewards = await Promise.all(binding.sources.map((source) => requireLearningRelease(transaction, "reward", source.reward)));
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
  const scan = scanAndRedactEvidence(JSON.stringify({ tasks: snapshot.evidence.map((item) => item.submission), targets: snapshot.decisions.map((item) => item.approvedTarget), definition: snapshot.definition }));
  if (scan.secretStatus !== "passed" || scan.piiStatus !== "passed") throw new Error(`Learning batch contains unresolved data findings (${scan.findings.join(", ")}). Correct the source examples and seal a revised batch before training.`);
  const source = LearningBatchDatasetSourceRefSchema.parse({
    schemaVersion: "openpond.learningBatchDatasetSource.v1", kind: "learning_batch", id: `batch-source-${snapshot.batch.contentHash.slice(0, 40)}`, profileId: input.profileId,
    title: snapshot.definition.name, sourceHash: snapshot.batch.contentHash, occurredAt: snapshot.batch.sealedAt,
    batch: learningRef(snapshot.batch), taskDefinition: snapshot.batch.taskDefinition, admittedBy: snapshot.batch.sealedBy,
    licensingStatus: "approved", secretScanStatus: scan.secretStatus, piiScanStatus: scan.piiStatus,
    metadata: { admission: "explicit_local_batch_review", privacyScanner: "openpond-evidence-v1", findings: scan.findings },
  });
  const { taskset, release, generatedFiles } = materializeLearningBatchTaskset({ ...snapshot, profileId: input.profileId, source });
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
