import { z } from "zod";
import { ProviderModelSchema, type ProviderModel } from "@openpond/contracts";
import {
  canonicalJson, canonicalSha256, SavedWeightModelSelectionSchema,
  parseAndVerifyAlphaEditModelVersion, parseAndVerifyNeuronTrainingModelVersion,
  parseAndVerifyResolvedWeightModelSelection, type AlphaEditModelVersion,
  type NeuronTrainingModelVersion, type ResolvedWeightModelSelection,
} from "openpond-sdk/training";
import type { SqliteStore } from "../store/store.js";
import { listManagedSavedModelVersions } from "./managed-saved-model-discovery.js";
import { accountFence, clientFor, configuredAccess, identity } from "./managed-saved-model-access.js";

const Hash = z.string().regex(/^[a-f0-9]{64}$/), Id = z.string().trim().min(1).max(240);
const Source = z.object({schemaVersion: z.literal("openpond.desktopWeightChatSelection.v1"),
  teamId: Id, actorId: Id, apiOrigin: z.url(), modelProjectId: Id, versionHash: Hash,
  method: z.enum(["alphaedit", "selective_neuron_training"])}).strict();
export const ManagedWeightChatOptionsSchema = z.object({savedModel: SavedWeightModelSelectionSchema.optional()}).strict();
export type ManagedWeightChatOptions = z.infer<typeof ManagedWeightChatOptionsSchema>;
type Version = AlphaEditModelVersion | NeuronTrainingModelVersion;
const CACHE_TYPE = "training.saved-weight-chat-selection.v1", PREFIX = "managed-weight:";
export type ManagedWeightChatAdmission = {
  apiOrigin: string; options: ManagedWeightChatOptions; selection: ResolvedWeightModelSelection; version: Version;
  poolId: string; routingBinding: {id: string; revision: number}; runtimeHash: string;
  workerImageDigest: string; assertCurrent: () => Promise<void>;
};
export function isManagedWeightChatModel(modelId: string | null | undefined) {
  return modelId?.startsWith(PREFIX) === true;
}
function method(version: Version) {
  return version.schemaVersion === "openpond.alphaEditModelVersion.v1" ? "alphaedit" as const : "selective_neuron_training" as const;
}
/** The existing home cache contains only an exact locator, never a serving
 * grant. Every send reauthorizes the immutable version through the SDK. */
export async function listManagedWeightChatModels(store: SqliteStore, teamId: string): Promise<ProviderModel[]> {
  const access = await configuredAccess(teamId), fence = () => accountFence(access), train = clientFor(access, fence);
  const versions = await listManagedSavedModelVersions(store, access);
  const models: ProviderModel[] = [];
  for (const {project, version} of versions) {
    if ((version?.schemaVersion !== "openpond.alphaEditModelVersion.v1" && version?.schemaVersion !== "openpond.neuronTrainingModelVersion.v1")
      || version.ownerUserId !== access.actorId) continue;
    const serving = await train.savedModelServing(project.id, {teamId, versionHash: version.contentHash});
    if ((serving.schemaVersion !== "openpond.alphaEditModelServing.v1" && serving.schemaVersion !== "openpond.neuronTrainingModelServing.v1")
      || serving.version.schemaVersion !== version.schemaVersion || serving.version.contentHash !== version.contentHash)
      throw new Error("The saved learned-weight Model changed its serving kind or version.");
    const source = Source.parse({...identity(access), schemaVersion: "openpond.desktopWeightChatSelection.v1",
      modelProjectId: project.id, versionHash: version.contentHash, method: method(version)});
    const hash = await canonicalSha256(source), prior = await store.getCacheEntry<unknown>(CACHE_TYPE, hash);
    if (prior && canonicalJson(Source.parse(prior.payload)) !== canonicalJson(source)) throw new Error("The saved Model locator changed its immutable identity.");
    if (!prior) await store.setCacheEntry(CACHE_TYPE, hash, source);
    const label = source.method === "alphaedit" ? "AlphaEdit" : "Neuron training";
    models.push(ProviderModelSchema.parse({id: PREFIX + hash, providerId: "openpond",
      displayName: `${project.name} / ${label} ${version.contentHash.slice(0, 8)}${serving.state === "active" ? "" : ` (${serving.state})`}`,
      source: "provider", outputLimit: 4096,
      capabilities: {streaming: true, toolCalling: true, reasoning: false, vision: false, structuredOutput: false},
      raw: {managedServing: true, managedWeight: true, method: source.method,
        savedModel: {modelProjectId: project.id, versionHash: version.contentHash},
        apiOrigin: source.apiOrigin, teamId, actorId: access.actorId, servingState: serving.state}}));
  }
  await fence(); return models;
}
export async function resolveManagedWeightChat(input: {
  store: SqliteStore; modelId: string; selectedTeamId: string | null; options: ManagedWeightChatOptions;
}) {
  if (!isManagedWeightChatModel(input.modelId)) return null;
  const hash = Hash.parse(input.modelId.slice(PREFIX.length)), entry = await input.store.getCacheEntry<unknown>(CACHE_TYPE, hash);
  if (!entry) throw new Error("This saved learned-weight selection is unavailable. Refresh Models and select its exact version again.");
  const source = Source.parse(entry.payload);
  if (await canonicalSha256(source) !== hash) throw new Error("The saved learned-weight selection failed its immutable identity check.");
  if (input.selectedTeamId !== source.teamId) throw new Error("Select this saved Model's original workspace before sending a message.");
  const access = await configuredAccess(source.teamId);
  if (canonicalJson(identity(access)) !== canonicalJson({teamId: source.teamId, actorId: source.actorId, apiOrigin: source.apiOrigin}))
    throw new Error("This saved Model belongs to another account or hosted API. Select it again in its original account.");
  const fence = () => accountFence(access), train = clientFor(access, fence), options = ManagedWeightChatOptionsSchema.parse(input.options);
  const savedModel = {modelProjectId: source.modelProjectId, versionHash: source.versionHash};
  if (options.savedModel && canonicalJson(options.savedModel) !== canonicalJson(savedModel)) throw new Error("The request differs from the selected learned-weight Model.");
  const serving = await train.savedModelServing(source.modelProjectId, {teamId: source.teamId, versionHash: source.versionHash});
  if ((serving.schemaVersion !== "openpond.alphaEditModelServing.v1" && serving.schemaVersion !== "openpond.neuronTrainingModelServing.v1")
    || serving.version.contentHash !== source.versionHash || serving.version.ownerUserId !== source.actorId
    || method(serving.version) !== source.method || serving.state !== "active" || serving.availability.state !== "qualified")
    throw new Error("Enable qualified serving for this exact saved learned-weight Model before sending a message.");
  const expectedScope = {teamId: source.teamId, modelProjectId: source.modelProjectId, ownerUserId: source.actorId};
  const version = serving.version.schemaVersion === "openpond.alphaEditModelVersion.v1"
    ? await parseAndVerifyAlphaEditModelVersion(serving.version, expectedScope)
    : await parseAndVerifyNeuronTrainingModelVersion(serving.version, expectedScope);
  const control = serving.control, ref = control?.binding;
  const binding = ref && serving.bindings.find(row => row.id === ref.id && row.revision === ref.revision
    && row.versionHash === source.versionHash && row.poolId === control?.poolId && row.modelId === `personalized:model:${source.modelProjectId}`);
  const pool = binding && serving.pools.find(row => row.id === binding.poolId && row.state === "ready" && row.endpointRecorded);
  if (!control || control.actorId !== source.actorId || control.desiredState !== "active" || control.phase !== "active"
    || control.versionHash !== source.versionHash || !binding || !pool?.workerImageDigest || !serving.availability.runtimeHash)
    throw new Error("This saved learned-weight Model has no verified active serving binding.");
  const selection = await parseAndVerifyResolvedWeightModelSelection({schemaVersion: "openpond.resolvedWeightModelSelection.v1",
    method: source.method, savedModel, artifact: {id: version.artifact.id, contentHash: version.artifact.contentHash,
      manifestSha256: await canonicalSha256(version.artifact.manifest)}, modelHash: await canonicalSha256(version.request.model)}, version);
  await fence();
  return {teamId: source.teamId, logicalModelName: binding.modelId, options: {savedModel},
    admission: {apiOrigin: source.apiOrigin, options: {savedModel}, version, selection, poolId: pool.id,
      routingBinding: {id: binding.id, revision: binding.revision}, runtimeHash: serving.availability.runtimeHash,
      workerImageDigest: pool.workerImageDigest, assertCurrent: fence} satisfies ManagedWeightChatAdmission};
}
