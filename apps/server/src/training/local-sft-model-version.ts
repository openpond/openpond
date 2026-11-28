import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { open } from "node:fs/promises";
import path from "node:path";
import { contentHash } from "@openpond/harness";
import type { BenchmarkModelVersion } from "@openpond/contracts/resource-setup";
import type { SqliteStore } from "../store/store.js";
import { localTrainingModelAssets } from "./local-training-model-assets.js";

type LocalVersion = Extract<BenchmarkModelVersion, { location: "local" }>;
const changedArtifact = "The saved adapter file changed.";

async function verifyFile(file: string, expected: { sha256: string; sizeBytes: number }, fail: (message: string) => never, signal?: AbortSignal) {
  const hash = createHash("sha256");
  let size = 0;
  const changed = new Error("Saved adapter size changed.");
  try {
    const handle = await open(file, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0));
    try {
      const stat = await handle.stat();
      if (!stat.isFile() || stat.size !== expected.sizeBytes) throw changed;
      for await (const chunk of handle.createReadStream({ signal, autoClose: false })) {
        size += chunk.length;
        if (size > expected.sizeBytes) throw changed;
        hash.update(chunk);
      }
    } finally { await handle.close(); }
  } catch (error) {
    signal?.throwIfAborted();
    if (error === changed) fail(changedArtifact);
    fail("The saved adapter file is unavailable.");
  }
  if (size !== expected.sizeBytes || hash.digest("hex") !== expected.sha256) fail(changedArtifact);
}

export function createLocalSftVersionReader(store: SqliteStore, home: string, fail: (message: string) => never) {
  async function resolve(source: LocalVersion, profileId?: string) {
    const [project, lineage] = await Promise.all([store.getModelProject(source.projectId), store.getModelArtifactLineage(source.versionId)]);
    if (!project || profileId && profileId !== project.profileId || !lineage || lineage.modelId !== project.id ||
      lineage.status !== "imported" || lineage.artifactId !== source.artifactId || lineage.bundleHash !== source.bundleHash)
      fail("The selected local Model Version is unavailable in this library.");
    const run = await store.getModelRun(lineage.jobId);
    const receipt = run?.receipt;
    if (run?.modelId !== project.id || run.profileId !== project.profileId || run.status !== "succeeded" ||
      run.adapterArtifactLineageId !== lineage.id || !run.localSft || receipt?.schemaVersion !== "openpond.localSftModelRunReceipt.v1" ||
      receipt.contentHash !== lineage.bundleHash || receipt.planHash !== run.localSft.planHash || !run.modelVersionId)
      fail("This Version needs a retained local SFT run and its verified adapter.");
    const version = await store.getModelVersion(run.modelVersionId);
    if (version?.localSft?.modelRunId !== run.id || version.profileId !== project.profileId ||
      version.modelId !== project.id || version.artifactLineageId !== lineage.id || version.status !== "available" ||
      version.localSft.planHash !== run.localSft.planHash || version.localSft.attemptId !== run.localSft.attemptId ||
      version.localSft.sessionId !== run.localSft.sessionId || !version.baseModel.modelAssetId)
      fail("The saved Version no longer matches its original Model Run.");
    const { contentHash: versionHash, ...versionContent } = version;
    const { contentHash: receiptHash, ...receiptContent } = receipt;
    if (contentHash(versionContent) !== versionHash || contentHash(receiptContent) !== receiptHash)
      fail("The saved Version or Model Run receipt failed integrity verification.");
    return { project, version, run, receipt };
  }

  async function artifacts(source: LocalVersion, selected: Awaited<ReturnType<typeof resolve>>, signal?: AbortSignal) {
    const files = await store.listTrainingArtifacts(selected.run.id);
    const weights = files.find(file => file.id === source.artifactId && file.metadata.providerFilename === "adapter_model.safetensors");
    const config = files.find(file => file.metadata.providerFilename === "adapter_config.json" && file.metadata.provider === "local_cuda");
    const reference = selected.version.localSft!;
    const directory = path.resolve(home, "training", "local-sft", "runs", reference.planHash, reference.attemptId, "adapter");
    if (!weights || !config || weights.sha256 !== selected.receipt.adapterHash ||
      config.sha256 !== selected.receipt.adapterConfigHash || weights.metadata.provider !== "local_cuda" ||
      weights.path !== path.join(directory, "adapter_model.safetensors") || config.path !== path.join(directory, "adapter_config.json"))
      fail("The stored adapter files do not match the saved Version.");
    await Promise.all([verifyFile(weights.path, weights, fail, signal), verifyFile(config.path, config, fail, signal)]);
    const { base, modelDirectory, manifestFiles } = await localTrainingModelAssets(home).verify(selected.version.baseModel.modelAssetId!, signal);
    const expected = selected.version.baseModel;
    if (base.preference.modelId !== expected.modelId || base.preference.revision !== expected.revision ||
      base.preference.tokenizerRevision !== expected.tokenizerRevision || base.preference.chatTemplateHash !== expected.chatTemplateHash)
      fail("The saved base checkpoint changed or could not be loaded.");
    return { adapterDirectory: directory, modelDirectory, baseSizeBytes: base.sizeBytes, chatTemplateHash: expected.chatTemplateHash,
      baseFiles: manifestFiles, weights, config, files: { "adapter_model.safetensors": weights.sha256, "adapter_config.json": config.sha256 } };
  }

  return { resolve, artifacts };
}
