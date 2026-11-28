import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { access, mkdir } from "node:fs/promises";
import path from "node:path";
import { availableMemory } from "node:process";
import { z } from "zod";
import { contentHash } from "@openpond/harness";
import type { BenchmarkModelVersion } from "@openpond/contracts/resource-setup";
import type { SqliteStore } from "../store/store.js";
import { localTrainingModelAssets } from "../training/local-training-model-assets.js";
import { inspectLocalTrainingRuntime, localTrainingPythonCommand, runLocalTrainingPython } from "../training/local-training-runtime.js";
import type { LocalModelAdmission } from "./local-experiment-model.js";
import { LocalExperimentError, type LocalExperimentDefinition } from "./local-experiment-contract.js";
import { localSftBenchmarkWorker } from "./local-sft-benchmark-worker.js";

type LocalVersion = Extract<BenchmarkModelVersion, { location: "local" }>;
type Device = "cpu" | "cuda";
const resultSchema = z.discriminatedUnion("status", [
  z.object({ status: z.literal("completed"), text: z.string(), promptTokens: z.number().int().nonnegative(),
    completionTokens: z.number().int().nonnegative() }).strict(),
  z.object({ status: z.enum(["artifact_changed", "adapter_mismatch", "checkpoint_mismatch", "context_limit",
    "cuda_unavailable", "insufficient_memory", "device_busy", "tokenizer_incompatible", "runtime_failed"]) }).strict(),
]);
const explanations = {
  artifact_changed: "The saved adapter changed before inference.",
  adapter_mismatch: "The runtime did not load the exact saved adapter tensors.",
  checkpoint_mismatch: "The saved base checkpoint changed or could not be loaded.",
  context_limit: "This case and its output allocation exceed the model's context length.",
  cuda_unavailable: "The selected CUDA device is unavailable.",
  insufficient_memory: "The selected device has insufficient memory for the saved model.",
  device_busy: "A local training run or Benchmark is using the CUDA device.",
  tokenizer_incompatible: "The saved tokenizer could not render this Benchmark case.",
  runtime_failed: "The local Python runtime could not run the saved model.",
} as const;
function fail(message: string): never {
  throw new LocalExperimentError("saved_local_model_unavailable", message, 422);
}

async function verifyFile(file: string, expected: { sha256: string; sizeBytes: number }, signal?: AbortSignal) {
  const hash = createHash("sha256");
  let size = 0;
  try {
    for await (const chunk of createReadStream(file, { signal })) {
      size += chunk.length;
      if (size > expected.sizeBytes) fail(explanations.artifact_changed);
      hash.update(chunk);
    }
  } catch (error) {
    signal?.throwIfAborted();
    if (error instanceof LocalExperimentError) throw error;
    fail("The saved adapter file is unavailable.");
  }
  if (size !== expected.sizeBytes || hash.digest("hex") !== expected.sha256) fail(explanations.artifact_changed);
}

export function createLocalSftBenchmarkInference(store: SqliteStore, home: string) {
  async function resolve(source: LocalVersion, device: Device, profileId?: string) {
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
    const configurationHash = contentHash(["openpond-local-sft-benchmark-v1", version.contentHash, receipt.contentHash, device]);
    return { project, version, run, receipt, configurationHash };
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
    await Promise.all([verifyFile(weights.path, weights, signal), verifyFile(config.path, config, signal)]);
    const { base, modelDirectory } = await localTrainingModelAssets(home).verify(selected.version.baseModel.modelAssetId!, signal);
    const expected = selected.version.baseModel;
    if (base.preference.modelId !== expected.modelId || base.preference.revision !== expected.revision ||
      base.preference.tokenizerRevision !== expected.tokenizerRevision || base.preference.chatTemplateHash !== expected.chatTemplateHash)
      fail(explanations.checkpoint_mismatch);
    return { adapterDirectory: directory, modelDirectory, baseSizeBytes: base.sizeBytes, chatTemplateHash: expected.chatTemplateHash,
      files: { "adapter_model.safetensors": weights.sha256, "adapter_config.json": config.sha256 } };
  }

  return {
    resolve,
    async prepare(configuration: LocalExperimentDefinition["configuration"]): Promise<LocalModelAdmission> {
      const { policy } = configuration.request;
      if (policy.kind !== "hosted_chat" || policy.localRuntime?.providerId !== "local-sft-adapter" ||
        policy.harness || policy.candidate || policy.temperature !== 0 || policy.topP !== 1 || policy.maxOutputTokens > 2048)
        fail("Review this saved adapter as a text-only Benchmark with up to 2,048 output tokens.");
      const { providerId, device, requestTimeoutMs, configurationHash, ...pin } = policy.localRuntime;
      if (policy.modelId !== pin.versionId) fail("The selected adapter differs from the reviewed Model Version.");
      const source = { location: "local", ...pin } as const;
      const selected = await resolve(source, device);
      if (selected.configurationHash !== configurationHash) fail("The loaded Model Version differs from the reviewed configuration.");
      const verified = await artifacts(source, selected);
      await access(localTrainingPythonCommand(home, localSftBenchmarkWorker).executable).catch(() =>
        fail("Set up the local training Python environment to load this adapter."));
      if (device === "cuda" && (await inspectLocalTrainingRuntime(home)).status !== "ready")
        fail(explanations.cuda_unavailable);
      if (device === "cpu" && verified.baseSizeBytes * 4 > availableMemory()) fail(explanations.insufficient_memory);
      const model = { providerId, modelId: policy.modelId, maxOutputTokens: policy.maxOutputTokens, configurationHash, messages: policy.messages ?? [] };
      return { model, pricing: null, maximumChargeUsd: 0, stream: async function* (request) {
        if (request.tools?.length || request.messages.some(message => message.images?.length || message.tool_calls?.length))
          fail("The saved adapter Benchmark accepts text messages only.");
        const messages = z.array(z.object({ role: z.enum(["user", "system", "assistant"]), content: z.string().max(100_000) }))
          .max(100).safeParse(request.messages);
        if (!messages.success || JSON.stringify(messages.data).length > 100_000) fail("The saved adapter Benchmark case exceeds the text input limit.");
        const latest = await resolve(source, device);
        if (latest.configurationHash !== configurationHash) fail("The reviewed Model Version changed before dispatch.");
        const files = await artifacts(source, latest, request.signal);
        if (device === "cpu" && files.baseSizeBytes * 4 > availableMemory()) fail(explanations.insufficient_memory);
        const root = path.resolve(home, "training", "local-sft", "runs");
        await mkdir(root, { recursive: true, mode: 0o700 });
        const result = await runLocalTrainingPython(home, localSftBenchmarkWorker, {
          timeout: requestTimeoutMs, signal: request.signal, input: { ...files, messages: messages.data, device,
            deviceLock: path.join(root, device === "cuda" ? "device.lock" : "cpu-inference.lock"), maxOutputTokens: request.maxTokens },
        }).then(value => resultSchema.parse(value)).catch(error => {
          request.signal?.throwIfAborted();
          fail((error as NodeJS.ErrnoException).code === "ENOENT"
            ? "Set up the local training Python environment to load this adapter." : explanations.runtime_failed);
        });
        if (result.status !== "completed") fail(explanations[result.status]);
        yield { type: "text_delta", text: result.text, raw: null };
        yield { type: "usage", usage: { prompt_tokens: result.promptTokens, completion_tokens: result.completionTokens,
          total_tokens: result.promptTokens + result.completionTokens }, raw: null };
        yield { type: "finish", finishReason: result.completionTokens >= model.maxOutputTokens ? "length" : "stop", raw: null };
      } };
    },
  };
}
