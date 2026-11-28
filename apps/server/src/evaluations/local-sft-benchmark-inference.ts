import { access, mkdir } from "node:fs/promises";
import path from "node:path";
import { availableMemory } from "node:process";
import { z } from "zod";
import { contentHash } from "@openpond/harness";
import type { BenchmarkModelVersion } from "@openpond/contracts/resource-setup";
import type { SqliteStore } from "../store/store.js";
import { createLocalSftVersionReader } from "../training/local-sft-model-version.js";
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

export function createLocalSftBenchmarkInference(store: SqliteStore, home: string) {
  const reader = createLocalSftVersionReader(store, home, fail);
  const { artifacts } = reader;

  async function resolve(source: LocalVersion, device: Device, profileId?: string) {
    const selected = await reader.resolve(source, profileId);
    const configurationHash = contentHash(["openpond-local-sft-benchmark-v1", selected.version.contentHash, selected.receipt.contentHash, device]);
    return { ...selected, configurationHash };
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
          timeout: requestTimeoutMs, signal: request.signal, input: {
            adapterDirectory: files.adapterDirectory, modelDirectory: files.modelDirectory, files: files.files,
            baseSizeBytes: files.baseSizeBytes, chatTemplateHash: files.chatTemplateHash, messages: messages.data, device,
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
