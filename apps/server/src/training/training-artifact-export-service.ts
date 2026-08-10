import { readFile } from "node:fs/promises";
import path from "node:path";
import { sha256 } from "@openpond/taskset-sdk";
import { createTrainingBundleExport } from "@openpond/training-sdk";
import type { SqliteStore } from "../store/store.js";
import { selectPortableModelArtifacts } from "./training-artifact-package.js";

export function createTrainingArtifactExportService(deps: {
  store: SqliteStore;
  storeDir: string;
}) {
  async function exportBundle(bundleId: string) {
    const bundle = await deps.store.getTrainingBundle(bundleId);
    if (!bundle) throw new Error("Training Bundle not found.");
    const directory = path.join(
      deps.storeDir,
      "training",
      "bundles",
      bundle.planId,
    );
    const exported = await createTrainingBundleExport(directory);
    return {
      filename: `${bundle.id}.openpond-model-improvement-bundle.json`,
      content: JSON.stringify(exported),
    };
  }

  async function artifactDownload(id: string) {
    const artifact = await deps.store.getTrainingArtifact(id);
    if (!artifact) throw new Error("Training artifact not found.");
    const bytes = await readFile(artifact.path);
    if (
      sha256(bytes) !== artifact.sha256
      || bytes.byteLength !== artifact.sizeBytes
    ) {
      throw new Error(
        "Training artifact failed integrity verification.",
      );
    }
    return { artifact, path: artifact.path };
  }

  async function modelPackageDownload(id: string) {
    const model = await deps.store.getModelArtifactLineage(id);
    if (!model || model.status !== "imported") {
      throw new Error("Imported Model was not found.");
    }
    const artifacts = selectPortableModelArtifacts(
      await deps.store.listTrainingArtifacts(model.jobId),
    );
    const singleFileWeights = artifacts.find(
      (entry) => entry.name === "adapter_model.safetensors",
    );
    const shardedWeights = artifacts.filter((entry) =>
      /^adapter_model-\d{5}-of-\d{5}\.safetensors$/.test(entry.name)
    );
    const weights = singleFileWeights?.artifact
      ?? shardedWeights[0]?.artifact;
    const weightsIndex = artifacts.find(
      (entry) => entry.name === "adapter_model.safetensors.index.json",
    );
    const configuration = artifacts.find(
      (entry) => entry.name === "adapter_config.json",
    )?.artifact;
    const completeWeights =
      Boolean(singleFileWeights)
      || (shardedWeights.length > 0 && Boolean(weightsIndex));
    if (!weights || !configuration || !completeWeights) {
      throw new Error(
        "The imported Model is missing its LoRA weights or adapter configuration.",
      );
    }
    for (const { artifact } of artifacts) {
      const bytes = await readFile(artifact.path);
      if (
        bytes.byteLength !== artifact.sizeBytes
        || sha256(bytes) !== artifact.sha256
      ) {
        throw new Error(
          `Training artifact ${artifact.id} failed integrity verification.`,
        );
      }
    }
    const job = await deps.store.getTrainingJob(model.jobId);
    const plan = job
      ? await deps.store.getTrainingPlan(job.planId)
      : null;
    const manifest = Buffer.from(
      `${JSON.stringify({
        schemaVersion: "openpond.modelPackage.v1",
        modelArtifactLineageId: model.id,
        jobId: model.jobId,
        tasksetId: model.tasksetId,
        tasksetHash: model.tasksetHash,
        graderHash: model.graderHash,
        planHash: model.planHash,
        bundleHash: model.bundleHash,
        recipeHash: model.recipeHash,
        baseModel: {
          id: weights.baseModelId,
          revision: weights.baseModelRevision,
          tokenizerRevision: weights.tokenizerRevision,
          chatTemplateHash: weights.chatTemplateHash,
        },
        provider: job?.metadata.provider ?? null,
        providerJobId: job?.metadata.providerJobId ?? null,
        outputModelName: job?.metadata.outputModelName ?? null,
        trainingMethod: plan?.recipe.method ?? null,
        files: artifacts.map((entry) => ({
          name: entry.name,
          providerFilename: entry.providerFilename,
          sha256: entry.artifact.sha256,
          sizeBytes: entry.artifact.sizeBytes,
        })),
        exportedAt: new Date().toISOString(),
      }, null, 2)}\n`,
      "utf8",
    );
    return {
      filename: `${model.id}.openpond-lora.tar`,
      manifest,
      entries: artifacts.map((entry) => ({
        artifact: entry.artifact,
        name: `model/${entry.name}`,
      })),
    };
  }

  return {
    exportBundle,
    artifactDownload,
    modelPackageDownload,
  };
}
