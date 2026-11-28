import { constants } from "node:fs";
import { open } from "node:fs/promises";
import { contentHash, sha256 } from "@openpond/harness";
import type { LocalAdapterPublicationRequest, LocalAdapterPublicationState } from "@openpond/contracts/resource-setup";
import { createModelProjectsClient, OpenPondModelProjectApiError, type RegisteredAdapterAttach } from "openpond-sdk/model-projects";
import { canonicalJson, canonicalSha256 } from "openpond-sdk/training";
import { z } from "zod";
import { hostedApiAuthHeaders } from "../openpond/hosted-api-access.js";
import type { SqliteStore } from "../store/store.js";
import { createLocalSftVersionReader } from "./local-sft-model-version.js";
import { uploadLocalAdapterToRegistry } from "./local-adapter-registry-upload.js";

const maxBytes = 256 * 1024 * 1024;
const initialBaseProfile = "qwen3-0-6b-c1899de2";
const hash = z.string().regex(/^[a-f0-9]{64}$/);
const baseProfileSchema = z.object({
  id: z.string(), repository: z.string().min(1), revision: z.string().regex(/^[a-f0-9]{40}$/),
  status: z.string(), configHash: hash, tokenizerHash: hash, tokenizerConfigHash: hash, chatTemplateHash: hash, modelIndexHash: hash,
  lora: z.object({ maxRank: z.number().int().positive(), allowedTargetModules: z.array(z.string()) }),
});
const configSchema = z.object({
  peft_type: z.literal("LORA"), base_model_name_or_path: z.string(), revision: z.string(), r: z.number().int().positive(),
  lora_alpha: z.number().positive(), lora_dropout: z.literal(0), bias: z.literal("none"), modules_to_save: z.null(),
  target_modules: z.array(z.string()).min(1), use_dora: z.literal(false).optional(), use_rslora: z.literal(false).optional(),
}).passthrough();
type Access = { teamId: string; actorId: string; apiBaseUrl: string; token: string };

export class LocalAdapterPublicationError extends Error {
  constructor(message: string, readonly status = 409) { super(message); }
}
function fail(message: string): never { throw new LocalAdapterPublicationError(message); }

/** Retain the exact checked bytes before sending them to a scoped object URL. */
async function verifiedBytes(file: { path: string; sizeBytes: number; sha256: string }, limit: number, signal: AbortSignal) {
  if (file.sizeBytes > limit) fail("This adapter exceeds the registry upload limit.");
  const handle = await open(file.path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0));
  try {
    const before = await handle.stat();
    if (!before.isFile() || before.size !== file.sizeBytes) fail("The saved adapter file changed.");
    const bytes = Buffer.alloc(file.sizeBytes);
    let offset = 0;
    while (offset < bytes.length) {
      signal.throwIfAborted();
      const { bytesRead } = await handle.read(bytes, offset, Math.min(bytes.length - offset, 1024 * 1024), offset);
      if (!bytesRead) fail("The saved adapter file changed.");
      offset += bytesRead;
    }
    if (sha256(bytes) !== file.sha256 || (await handle.stat()).size !== before.size) fail("The saved adapter file changed.");
    return bytes;
  } finally { await handle.close(); }
}

export function createLocalAdapterPublicationService(input: {
  store: SqliteStore; home: string; resolveAccess(): Promise<Access>; fetch?: typeof fetch;
}) {
  const reader = createLocalSftVersionReader(input.store, input.home, fail);
  const fetchImpl = input.fetch ?? fetch;
  const publishing = new Set<string>();

  async function review(request: LocalAdapterPublicationRequest, signal: AbortSignal) {
    const access = await input.resolveAccess();
    const apiOrigin = new URL(access.apiBaseUrl).origin;
    async function currentAccess() {
      signal.throwIfAborted();
      const now = await input.resolveAccess();
      if (now.teamId !== request.teamId || now.actorId !== request.actorId || new URL(now.apiBaseUrl).origin !== apiOrigin)
        fail("The selected workspace or account changed. Reopen the adapter review.");
      return now;
    }
    await currentAccess();
    const selected = await reader.resolve(request.version, request.profileId);
    const link = selected.project.hosted;
    if (!link || link.teamId !== access.teamId || link.apiOrigin !== apiOrigin || link.portableProjectId !== selected.project.id)
      fail("Sync this Model to the selected workspace using Cloud, then reopen the adapter review.");

    // Registry requests use the active public account. Presigned PUT requests have a separate transport.
    const hostedFetch: typeof fetch = async (url, init) => {
      const target = new URL(String(url));
      if (target.origin !== apiOrigin) fail("The Model's hosted API changed.");
      const now = await currentAccess();
      const headers = new Headers(init?.headers);
      hostedApiAuthHeaders(now.token).forEach((value, name) => headers.set(name, value));
      headers.set("x-openpond-team-id", now.teamId);
      return fetchImpl(url, { ...init, headers, signal, redirect: "error" });
    };
    const client = createModelProjectsClient({ baseUrl: access.apiBaseUrl, fetch: hostedFetch });
    const hosted = (await client.get(link.projectId)).project;
    if (hosted.teamId !== request.teamId || hosted.id !== link.projectId || hosted.portableProjectId !== selected.project.id)
      fail("The hosted Model does not match the selected local Model.");
    const verified = await reader.artifacts(request.version, selected, signal);
    const capabilities = await hostedFetch(`${access.apiBaseUrl}/v1/model-adapters/capabilities`);
    if (!capabilities.ok) fail(`The workspace adapter registry is unavailable (${capabilities.status}).`);
    const profile = z.object({ schemaVersion: z.literal("openpond.modelAdapterPlatformCapabilities.v1"), baseProfiles: z.array(baseProfileSchema).max(100) })
      .parse(await capabilities.json()).baseProfiles.find(item => item.status === "supported" && item.id === initialBaseProfile);
    const fileHash = (name: string) => verified.baseFiles.find(file => file.name === name)?.sha256;
    if (!profile || fileHash("config.json") !== profile.configHash || fileHash("tokenizer.json") !== profile.tokenizerHash ||
      fileHash("tokenizer_config.json") !== profile.tokenizerConfigHash || verified.chatTemplateHash !== profile.chatTemplateHash ||
      fileHash("model.safetensors") !== profile.modelIndexHash)
      fail("This version needs the exact supported Qwen3 0.6B checkpoint and tokenizer for an OpenPond Managed upload.");

    if (verified.weights.sizeBytes + verified.config.sizeBytes > maxBytes) fail("The LoRA adapter exceeds the 256 MiB direct-upload limit.");
    const config = configSchema.safeParse(JSON.parse((await verifiedBytes(verified.config, 1024 * 1024, signal)).toString("utf8")));
    if (!config.success || config.data.base_model_name_or_path !== selected.version.baseModel.modelId ||
      config.data.revision !== selected.version.baseModel.revision || config.data.r > profile.lora.maxRank ||
      config.data.lora_alpha !== config.data.r * 2 || new Set(config.data.target_modules).size !== config.data.target_modules.length ||
      config.data.target_modules.some(module => !profile.lora.allowedTargetModules.includes(module)))
      fail("This registry profile requires compatible LoRA targets, alpha equal to twice the rank, and zero dropout.");
    // Change only the source alias. Keep both the local and the uploaded Config digests in the receipt.
    const uploadedConfig = Buffer.from(canonicalJson({ ...config.data, base_model_name_or_path: profile.repository, revision: profile.revision }));
    const configSha256 = sha256(uploadedConfig);
    if (uploadedConfig.length + verified.weights.sizeBytes > maxBytes) fail("The LoRA adapter exceeds the 256 MiB direct-upload limit.");
    const localVersion: RegisteredAdapterAttach["localVersion"] = {
      id: selected.version.id, contentHash: selected.version.contentHash, adapterConfigSha256: verified.config.sha256,
      base: { modelAssetId: selected.version.baseModel.modelAssetId!, configSha256: profile.configHash,
        tokenizerSha256: profile.tokenizerHash, tokenizerConfigSha256: profile.tokenizerConfigHash,
        chatTemplateSha256: profile.chatTemplateHash, weightsSha256: profile.modelIndexHash },
    };
    const hostedVersionId = `adapter-version-${await canonicalSha256([hosted.id, localVersion.id])}`;
    const retained = await client.getRegisteredAdapter(hosted.id, request.teamId, hostedVersionId, signal).catch(error => {
      if (error instanceof OpenPondModelProjectApiError && error.status === 404 && error.code === "registered_adapter_version_not_found") return null;
      throw error;
    });
    if (retained && (retained.ownerUserId !== request.actorId || canonicalJson(retained.localVersion) !== canonicalJson(localVersion) ||
      retained.artifact.baseProfileId !== profile.id || retained.artifact.weightsSha256 !== verified.weights.sha256 || retained.artifact.configSha256 !== configSha256))
      fail("The saved hosted adapter differs from this local Model version.");

    const reviewHash = contentHash({ workspace: [apiOrigin, request.teamId, request.actorId], project: hosted.id, etag: hosted.etag,
      localVersion, baseProfileId: profile.id, adapter: [verified.weights.sha256, configSha256] });
    const state: LocalAdapterPublicationState = retained ? { state: "registered", version: retained } : {
      state: "review", reviewHash, modelName: selected.project.name, hostedModelId: hosted.id, baseRepository: profile.repository,
      baseRevision: profile.revision, bytes: uploadedConfig.length + verified.weights.sizeBytes,
      localVersionHash: localVersion.contentHash, adapterSha256: verified.weights.sha256,
    };
    await currentAccess();
    return { state, reviewHash, hosted, selected, verified, uploadedConfig, configSha256, profile, localVersion, client, hostedFetch, currentAccess, apiOrigin };
  }

  return {
    async preview(request: LocalAdapterPublicationRequest, signal: AbortSignal) { return (await review(request, signal)).state; },
    async publish(request: LocalAdapterPublicationRequest, expectedReview: string, signal: AbortSignal): Promise<LocalAdapterPublicationState> {
      const scope = JSON.stringify([request.teamId, request.version.projectId, request.version.versionId]);
      if (publishing.has(scope)) fail("This version is already uploading. Reopen the review to check its state.");
      publishing.add(scope);
      try {
        const value = await review(request, signal);
        if (value.state.state === "registered") return value.state;
        if (value.reviewHash !== expectedReview) fail("The checkpoint or hosted Model changed. Reopen the adapter review before uploading.");
        const bytes = await verifiedBytes(value.verified.weights, maxBytes, signal);
        const registryArtifact = await uploadLocalAdapterToRegistry({
          apiBaseUrl: (await value.currentAccess()).apiBaseUrl, teamId: request.teamId, actorId: request.actorId,
          hostedFetch: value.hostedFetch, fetch: fetchImpl, verifyScope: value.currentAccess, signal,
          label: `Local LoRA ${value.localVersion.contentHash.slice(0, 12)}`, baseProfileId: value.profile.id,
          idempotencyKey: `local-adapter:${contentHash([value.apiOrigin, request.teamId, request.actorId, value.localVersion, value.verified.weights.sha256, value.configSha256])}`,
          files: [
            { path: "adapter_config.json", mediaType: "application/json", sha256: value.configSha256, bytes: value.uploadedConfig },
            { path: "adapter_model.safetensors", mediaType: "application/vnd.safetensors", sha256: value.verified.weights.sha256, bytes },
          ],
        });
        const receipt = await value.client.attachRegisteredAdapter(value.hosted.id, {
          schemaVersion: "openpond.registeredAdapterAttach.v1", teamId: request.teamId, operationId: `attach-adapter:${value.reviewHash}`,
          expectedModelEtag: value.hosted.etag, localVersion: value.localVersion, artifact: registryArtifact,
        }, signal);
        await value.currentAccess();
        if (receipt.version.ownerUserId !== request.actorId) fail("The registry returned an adapter owned by a different account.");
        return { state: "registered", version: receipt.version };
      } finally { publishing.delete(scope); }
    },
  };
}
