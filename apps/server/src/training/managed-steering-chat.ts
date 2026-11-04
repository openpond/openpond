import { z } from "zod";
import { loadAuthenticatedOpenPondAccountContext } from "@openpond/runtime";
import { ProviderModelSchema, type ProviderModel } from "@openpond/contracts";
import {
  canonicalJson, canonicalSha256, createTrainingClient, OpenPondTrainingApiError, SteeringInferenceOptionsSchema,
  type SteeringInferenceOptions, type ResolvedSteeringSelection, type SteeringModelServing,
} from "openpond-sdk/training";
import type { SqliteStore } from "../store/store.js";
import { hostedApiAuthHeaders, resolveManagedAdapterUserAccess } from "../openpond/hosted-api-access.js";
import { listHostedModelProjectCatalog } from "./hosted-model-project-catalog.js";

const Id = z.string().trim().min(1).max(240), Hash = z.string().regex(/^[a-f0-9]{64}$/);
const Source = z.object({schemaVersion: z.literal("openpond.desktopSteeringChatSelection.v1"),
  teamId: Id, actorId: Id, apiOrigin: z.url(), modelProjectId: Id, versionHash: Hash}).strict();
const CACHE_TYPE = "training.saved-steering-chat-selection.v1";
const PREFIX = "managed-steering:";
type Access = Awaited<ReturnType<typeof configuredAccess>>;
export type ManagedSteeringChatAdmission = {
  apiOrigin: string;
  options: SteeringInferenceOptions; selection: ResolvedSteeringSelection; poolId: string;
  routingBinding: {id: string; revision: number}; runtimeHash: string; workerImageDigest: string;
  assertCurrent: () => Promise<void>;
};
export async function configuredAccess(teamId: string) {
  const context = await loadAuthenticatedOpenPondAccountContext();
  const actorId = context.accountState.profile?.id;
  if (context.accountState.state !== "signed_in" || !actorId) throw new Error("Sign in to use this saved steering Model.");
  return {...await resolveManagedAdapterUserAccess({teamId, loadAccountContext: async () => context}), actorId};
}
export function identity(access: Access) {
  return {teamId: access.teamId, actorId: access.actorId, apiOrigin: new URL(access.apiBaseUrl).origin};
}
export function clientFor(access: Access, fence: () => Promise<void>) {
  return createTrainingClient({baseUrl: access.apiBaseUrl, headers: () => {
    const headers = hostedApiAuthHeaders(access.token); headers.set("x-openpond-team-id", access.teamId); return headers;
  }, fetch: async (...args) => {await fence(); const response = await fetch(...args); await fence(); return response;}});
}
export async function accountFence(original: Access) {
  if (canonicalJson(identity(await configuredAccess(original.teamId))) !== canonicalJson(identity(original)))
    throw new Error("The account changed. Select this saved Model in its original account and workspace.");
}
export function isManagedSteeringChatModel(modelId: string | null | undefined) {
  return modelId?.startsWith(PREFIX) === true;
}
/** Cache entries are durable, non-authoritative locators in the existing home
 * cache owner. Refresh never replaces a selection with a newer version. A
 * cache reset requires selecting the canonical Model again. */
export async function listManagedSteeringChatModels(store: SqliteStore, teamId: string): Promise<ProviderModel[]> {
  const access = await configuredAccess(teamId), fence = () => accountFence(access), train = clientFor(access, fence);
  const catalog = await listHostedModelProjectCatalog({store, resolveAccess: async () => access,
    fetch: async (...args) => {await fence(); const response = await fetch(...args); await fence(); return response;}}, {refresh: true});
  const models: ProviderModel[] = [];
  // Sequential bounded catalog reads avoid a request fan-out per saved Model.
  if (catalog.projects.length > 1000) throw new Error("The saved Model catalog exceeds this Desktop selection bound.");
  for (const {project} of catalog.projects) {
    let read;
    try { read = await train.modelVersion(project.id, {teamId}); }
    catch (error) {
      // The shared Model catalog may include team-visible configurations whose
      // saved versions remain creator-scoped. They grant no chat authority.
      if (error instanceof OpenPondTrainingApiError && (error.status === 403 || error.status === 404)) continue;
      throw error;
    }
    const version = read.version;
    if (version?.schemaVersion !== "openpond.steeringModelVersion.v1" || version.publication.ownerUserId !== access.actorId) continue;
    const serving = await train.savedModelServing(project.id, {teamId, versionHash: version.contentHash});
    if (serving.schemaVersion !== "openpond.steeringModelServing.v1") throw new Error("The saved steering Model changed its serving kind.");
    const source = Source.parse({...identity(access), schemaVersion: "openpond.desktopSteeringChatSelection.v1",
      modelProjectId: project.id, versionHash: version.contentHash});
    const hash = await canonicalSha256(source), modelId = PREFIX + hash;
    const prior = await store.getCacheEntry<unknown>(CACHE_TYPE, hash);
    if (prior && canonicalJson(Source.parse(prior.payload)) !== canonicalJson(source)) throw new Error("The saved Model locator changed its immutable identity.");
    if (!prior) await store.setCacheEntry(CACHE_TYPE, hash, source);
    models.push(ProviderModelSchema.parse({id: modelId, providerId: "openpond",
      displayName: `${project.name} / Saved steering ${version.contentHash.slice(0, 8)}${serving.state === "active" ? "" : ` (${serving.state})`}`,
      source: "provider", outputLimit: 4096,
      capabilities: {streaming: true, toolCalling: true, reasoning: false, vision: false, structuredOutput: false},
      raw: {managedServing: true, managedSteering: true, savedModel: {modelProjectId: project.id, versionHash: version.contentHash},
        apiOrigin: source.apiOrigin, teamId, actorId: access.actorId, servingState: serving.state,
        defaultPublication: serving.defaultPublication}}));
  }
  await fence(); return models;
}
export async function resolveManagedSteeringChat(input: {
  store: SqliteStore; modelId: string; selectedTeamId: string | null;
  options: SteeringInferenceOptions;
}) {
  if (!isManagedSteeringChatModel(input.modelId)) return null;
  const hash = Hash.parse(input.modelId.slice(PREFIX.length));
  const entry = await input.store.getCacheEntry<unknown>(CACHE_TYPE, hash);
  if (!entry) throw new Error("This saved Model selection is unavailable. Refresh Models and select its exact saved version again.");
  const source = Source.parse(entry.payload);
  if (await canonicalSha256(source) !== hash) throw new Error("The saved Model selection failed its immutable identity check.");
  if (input.selectedTeamId !== source.teamId) throw new Error("Select this saved Model's original workspace before sending a message.");
  const access = await configuredAccess(source.teamId);
  if (canonicalJson(identity(access)) !== canonicalJson({teamId: source.teamId, actorId: source.actorId, apiOrigin: source.apiOrigin}))
    throw new Error("This saved Model belongs to another account or hosted API. Select it again in its original account.");
  const fence = () => accountFence(access), train = clientFor(access, fence);
  const options = SteeringInferenceOptionsSchema.parse(input.options);
  const savedModel = {modelProjectId: source.modelProjectId, versionHash: source.versionHash};
  if (options.savedModel && canonicalJson(options.savedModel) !== canonicalJson(savedModel)) throw new Error("The request differs from the selected saved Model version.");
  const serving = await train.savedModelServing(source.modelProjectId, {teamId: source.teamId, versionHash: source.versionHash});
  if (serving.schemaVersion !== "openpond.steeringModelServing.v1" || serving.version.contentHash !== source.versionHash
    || serving.version.publication.ownerUserId !== source.actorId || serving.state !== "active")
    throw new Error("Enable serving for this exact saved steering Model before sending a message.");
  const control = serving.control, bindingRef = control?.binding, poolId = control?.poolId;
  const binding = bindingRef && serving.bindings.find(row => row.id === bindingRef.id && row.revision === bindingRef.revision
    && row.versionHash === source.versionHash && row.poolId === poolId && row.modelId === `personalized:model:${source.modelProjectId}`);
  const pool = binding && serving.pools.find(row => row.id === binding.poolId && row.state === "ready" && row.endpointRecorded);
  if (!binding || !pool?.workerImageDigest || !serving.availability.runtimeHash) throw new Error("This saved Model has no verified active serving binding.");
  const requested = options.steering === undefined ? "inherit" : options.steering === null ? "off" : "override";
  const effective = requested === "inherit" ? serving.defaultPublication : options.steering ?? null;
  const profile = effective ? await resolvedProfile(train, serving, effective, source.actorId) : null;
  const selection: ResolvedSteeringSelection = {schemaVersion: "openpond.resolvedSteeringSelection.v1", requested, savedModel,
    defaultPublication: serving.defaultPublication, effectivePublication: effective, profileHash: profile?.contentHash ?? null,
    modelHash: await canonicalSha256(serving.version.publication.profile.model),
    calibration: profile?.normalization.mode === "fixed_residual_reference" ? profile.normalization.calibration : null};
  await fence();
  return {teamId: source.teamId, logicalModelName: binding.modelId, options: {...options, savedModel},
    admission: {apiOrigin: source.apiOrigin, options: {...options, savedModel}, selection, poolId: pool.id,
      routingBinding: {id: binding.id, revision: binding.revision}, runtimeHash: serving.availability.runtimeHash,
      workerImageDigest: pool.workerImageDigest, assertCurrent: fence} satisfies ManagedSteeringChatAdmission};
}
async function resolvedProfile(train: ReturnType<typeof createTrainingClient>, serving: SteeringModelServing,
  reference: NonNullable<SteeringInferenceOptions["steering"]>, actorId: string) {
  const record = await train.getSteeringProfile(serving.teamId, reference.id), publication = record.publication;
  if (record.archived || publication.ownerUserId !== actorId || publication.revision !== reference.revision
    || publication.contentHash !== reference.contentHash
    || canonicalJson(publication.profile.model) !== canonicalJson(serving.version.publication.profile.model))
    throw new Error("The exact steering profile is archived, incompatible or no longer available to this account.");
  return publication.profile;
}
