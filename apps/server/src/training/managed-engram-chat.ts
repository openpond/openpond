import { z } from "zod";
import { ProviderModelSchema, type ProviderModel } from "@openpond/contracts";
import {
  canonicalJson, canonicalSha256, EngramInferenceOptionsSchema,
  type EngramInferenceOptions, type ResolvedEngramSelection,
} from "openpond-sdk/training";
import type { SqliteStore } from "../store/store.js";
import { listManagedSavedModelVersions } from "./managed-saved-model-discovery.js";
import { accountFence, clientFor, configuredAccess, identity } from "./managed-saved-model-access.js";

const Hash = z.string().regex(/^[a-f0-9]{64}$/), Id = z.string().trim().min(1).max(240);
const Source = z.object({schemaVersion: z.literal("openpond.desktopEngramChatSelection.v1"),
  teamId: Id, actorId: Id, apiOrigin: z.url(), modelProjectId: Id, versionHash: Hash}).strict();
const CACHE_TYPE = "training.saved-engram-chat-selection.v1", PREFIX = "managed-engram:";
export type ManagedEngramChatAdmission = {
  apiOrigin: string; options: EngramInferenceOptions; selection: ResolvedEngramSelection;
  poolId: string; routingBinding: {id: string; revision: number};
  runtimeHash: string; workerImageDigest: string; assertCurrent: () => Promise<void>;
};
export function isManagedEngramChatModel(modelId: string | null | undefined) {
  return modelId?.startsWith(PREFIX) === true;
}
/** This existing-home cache stores only an exact locator. It grants no Model,
 * module or serving authority; every send reauthorizes the canonical version. */
export async function listManagedEngramChatModels(store: SqliteStore, teamId: string): Promise<ProviderModel[]> {
  const access = await configuredAccess(teamId), fence = () => accountFence(access);
  const versions = await listManagedSavedModelVersions(store, access);
  const models: ProviderModel[] = [];
  for (const {project, version} of versions) {
    if (version?.schemaVersion !== "openpond.engramModelVersion.v1" || version.ownerUserId !== access.actorId) continue;
    const source = Source.parse({...identity(access), schemaVersion: "openpond.desktopEngramChatSelection.v1",
      modelProjectId: project.id, versionHash: version.contentHash});
    const hash = await canonicalSha256(source), prior = await store.getCacheEntry<unknown>(CACHE_TYPE, hash);
    if (prior && canonicalJson(Source.parse(prior.payload)) !== canonicalJson(source)) throw new Error("The saved Model locator changed its immutable identity.");
    if (!prior) await store.setCacheEntry(CACHE_TYPE, hash, source);
    models.push(ProviderModelSchema.parse({id: PREFIX + hash, providerId: "openpond",
      displayName: `${project.name} / Saved memory ${version.contentHash.slice(0, 8)}`,
      source: "provider", outputLimit: 4096,
      capabilities: {streaming: true, toolCalling: true, reasoning: false, vision: false, structuredOutput: false},
      raw: {managedServing: true, managedEngram: true, savedModel: {modelProjectId: project.id, versionHash: version.contentHash},
        apiOrigin: source.apiOrigin, teamId, actorId: access.actorId}}));
  }
  await fence(); return models;
}
export async function resolveManagedEngramChat(input: {
  store: SqliteStore; modelId: string; selectedTeamId: string | null; options: EngramInferenceOptions;
}) {
  if (!isManagedEngramChatModel(input.modelId)) return null;
  const hash = Hash.parse(input.modelId.slice(PREFIX.length)), entry = await input.store.getCacheEntry<unknown>(CACHE_TYPE, hash);
  if (!entry) throw new Error("This saved memory selection is unavailable. Refresh Models and select its exact version again.");
  const source = Source.parse(entry.payload);
  if (await canonicalSha256(source) !== hash) throw new Error("The saved memory selection failed its immutable identity check.");
  if (input.selectedTeamId !== source.teamId) throw new Error("Select this saved Model's original workspace before sending a message.");
  const access = await configuredAccess(source.teamId);
  if (canonicalJson(identity(access)) !== canonicalJson({teamId: source.teamId, actorId: source.actorId, apiOrigin: source.apiOrigin}))
    throw new Error("This saved Model belongs to another account or hosted API. Select it again in its original account.");
  const fence = () => accountFence(access), train = clientFor(access, fence), options = EngramInferenceOptionsSchema.parse(input.options);
  const savedModel = {modelProjectId: source.modelProjectId, versionHash: source.versionHash};
  if (options.savedModel && canonicalJson(options.savedModel) !== canonicalJson(savedModel)) throw new Error("The request differs from the selected saved memory Model.");
  const serving = await train.savedModelServing(source.modelProjectId, {teamId: source.teamId, versionHash: source.versionHash});
  if (serving.schemaVersion !== "openpond.engramModelServing.v1" || serving.version.contentHash !== source.versionHash
    || serving.version.ownerUserId !== source.actorId || serving.state !== "active")
    throw new Error("Enable serving for this exact saved memory Model before sending a message.");
  const control = serving.control, ref = control?.binding;
  const binding = ref && serving.bindings.find(row => row.id === ref.id && row.revision === ref.revision
    && row.versionHash === source.versionHash && row.poolId === control?.poolId && row.modelId === `personalized:model:${source.modelProjectId}`);
  const pool = binding && serving.pools.find(row => row.id === binding.poolId && row.state === "ready" && row.endpointRecorded);
  if (!binding || !pool?.workerImageDigest || !serving.availability.runtimeHash) throw new Error("This saved memory Model has no verified active serving binding.");
  const artifact = serving.version.artifact, payload = artifact.files.find(file => file.path === "adapter.safetensors");
  if (!payload) throw new Error("The saved memory module has no committed tensor payload.");
  const selection: ResolvedEngramSelection = {schemaVersion: "openpond.resolvedEngramSelection.v1",
    requested: options.engram === undefined ? "inherit" : options.engram ? "on" : "off", savedModel,
    defaultEnabled: serving.defaultEnabled, effectiveEnabled: options.engram ?? serving.defaultEnabled,
    module: {id: artifact.id, contentHash: artifact.contentHash, payloadSha256: payload.sha256}, modelHash: await canonicalSha256(artifact.manifest.pins.baseModel)};
  await fence();
  return {teamId: source.teamId, logicalModelName: binding.modelId, options: {...options, savedModel},
    admission: {apiOrigin: source.apiOrigin, options: {...options, savedModel}, selection,
      poolId: pool.id, routingBinding: {id: binding.id, revision: binding.revision}, runtimeHash: serving.availability.runtimeHash,
      workerImageDigest: pool.workerImageDigest, assertCurrent: fence} satisfies ManagedEngramChatAdmission};
}
