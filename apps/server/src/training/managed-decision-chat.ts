import { z } from "zod";
import { contentHash } from "@openpond/harness";
import { DecisionModelScoreIntentSchema, ProviderModelSchema, type ProviderModel } from "@openpond/contracts";
import {
  canonicalJson, canonicalSha256, DecisionModelScoreRequestSchema, DecisionModelScoreReceiptSchema,
  parseDecisionModelScoreRequest, parseAndVerifyDecisionModelScoreReceipt, SavedDecisionModelSelectionSchema, type DecisionModelScoreReceipt,
} from "openpond-sdk/training";
import type { SqliteStore } from "../store/store.js";
import { accountFence, clientFor, configuredAccess, identity } from "./managed-saved-model-access.js";
import { listManagedSavedModelVersions } from "./managed-saved-model-discovery.js";
import { validateReviewedEvaluationCommand } from "./reviewed-evaluation-operation.js";

const Id = z.string().trim().min(1).max(240), Hash = z.string().regex(/^[a-f0-9]{64}$/);
const Source = z.object({
  schemaVersion: z.literal("openpond.desktopDecisionChatSelection.v1"),
  teamId: Id, actorId: Id, apiOrigin: z.url(), modelProjectId: Id, versionHash: Hash,
}).strict();
const LOCATORS = "training.saved-decision-chat-selection.v1";
const SCORES = "training.saved-decision-chat-score.v1";
const PREFIX = "managed-decision:";
const ACTION = "training-decision-score";
export const ManagedDecisionChatInputSchema = DecisionModelScoreRequestSchema.pick({ input: true, limits: true });
const Attempt = z.object({
  source: Source, chatRequestId: Id, scopeHash: Hash, intentHash: Hash,
  intent: DecisionModelScoreIntentSchema, request: DecisionModelScoreRequestSchema,
  receipt: DecisionModelScoreReceiptSchema.nullable(),
}).strict();
const active = new WeakMap<SqliteStore, Map<string, Promise<DecisionModelScoreReceipt>>>();

export function isManagedDecisionChatModel(modelId: string | null | undefined) {
  return modelId?.startsWith(PREFIX) === true;
}

/** Discovery retains a locator, not a serving or scoring grant. */
export async function listManagedDecisionChatModels(store: SqliteStore, teamId: string): Promise<ProviderModel[]> {
  const access = await configuredAccess(teamId);
  const versions = await listManagedSavedModelVersions(store, access);
  const models: ProviderModel[] = [];
  for (const { project, version } of versions) {
    if (version?.schemaVersion !== "openpond.decisionModelVersion.v1" || version.ownerUserId !== access.actorId) continue;
    const source = Source.parse({ ...identity(access), schemaVersion: "openpond.desktopDecisionChatSelection.v1",
      modelProjectId: project.id, versionHash: version.contentHash });
    const hash = await canonicalSha256(source), prior = await store.getCacheEntry<unknown>(LOCATORS, hash);
    if (prior && canonicalJson(Source.parse(prior.payload)) !== canonicalJson(source))
      throw new Error("The saved Decision Model locator changed its immutable identity.");
    if (!prior) await store.setCacheEntry(LOCATORS, hash, source);
    models.push(ProviderModelSchema.parse({
      id: PREFIX + hash, providerId: "openpond", displayName: `${project.name} / Decision ${version.contentHash.slice(0, 8)}`,
      source: "provider", capabilities: { streaming: false, toolCalling: false, reasoning: false, vision: false, structuredOutput: true },
      raw: { managedServing: true, managedDecision: true,
        savedModel: { modelProjectId: project.id, versionHash: version.contentHash },
        apiOrigin: source.apiOrigin, teamId, actorId: access.actorId },
    }));
  }
  await accountFence(access);
  return models;
}

export function parseManagedDecisionChatInput(text: string) {
  if (Buffer.byteLength(text, "utf8") > 131_072) throw new Error("Decision input exceeds its supported size.");
  try { return ManagedDecisionChatInputSchema.parse(JSON.parse(text)); }
  catch { throw new Error("Provide the Decision Model's state, allowed answers and scoring limits before scoring."); }
}

/** The ordinary chat turn is the user's scoring request. The existing reviewed
 * operation journal retains its exact bytes before dispatch; retries reuse the
 * original request even after a lost response or process restart. */
export async function scoreManagedDecisionChat(input: {
  store: SqliteStore; modelId: string; selectedTeamId: string | null;
  requestId: string; payload: z.infer<typeof ManagedDecisionChatInputSchema>; signal: AbortSignal;
  savedModel?: z.infer<typeof SavedDecisionModelSelectionSchema>;
}) {
  if (!isManagedDecisionChatModel(input.modelId)) throw new Error("Select an exact saved Decision Model.");
  const hash = Hash.parse(input.modelId.slice(PREFIX.length));
  const locator = await input.store.getCacheEntry<unknown>(LOCATORS, hash);
  if (!locator) throw new Error("Refresh Models and select the saved Decision version again.");
  const source = Source.parse(locator.payload);
  if (await canonicalSha256(source) !== hash) throw new Error("The saved Decision Model selection failed its identity check.");
  if (input.selectedTeamId !== source.teamId) throw new Error("Select this Decision Model's original workspace before scoring.");
  const access = await configuredAccess(source.teamId);
  if (canonicalJson(identity(access)) !== canonicalJson({ teamId: source.teamId, actorId: source.actorId, apiOrigin: source.apiOrigin }))
    throw new Error("Select this Decision Model in its original account and hosted API.");
  const requestId = Id.parse(input.requestId), payload = ManagedDecisionChatInputSchema.parse(input.payload);
  if (input.savedModel && canonicalJson(SavedDecisionModelSelectionSchema.parse(input.savedModel)) !== canonicalJson({ modelProjectId: source.modelProjectId, versionHash: source.versionHash }))
    throw new Error("The scoring request differs from the selected saved Decision Model version.");
  const intent = DecisionModelScoreIntentSchema.parse({ account: identity(access), modelProjectId: source.modelProjectId,
    request: { schemaVersion: "openpond.decisionModelScoreRequest.v1", teamId: source.teamId, versionHash: source.versionHash, ...payload } });
  parseDecisionModelScoreRequest({ ...intent.request, requestId });
  const scopeHash = contentHash({ ...identity(access), projectId: null }), intentHash = contentHash(intent);
  const key = await canonicalSha256({ source, requestId });
  let running = active.get(input.store);
  if (!running) { running = new Map(); active.set(input.store, running); }
  const existing = running.get(key);
  if (existing) {
    const result = await existing;
    input.signal.throwIfAborted();
    if (result.requestHash !== await canonicalSha256({ modelProjectId: source.modelProjectId,
      request: { ...intent.request, requestId: result.requestId } }))
      throw new Error("The chat scoring request changed while its original operation was running.");
    await accountFence(access);
    return result;
  }
  const operation = perform();
  running.set(key, operation);
  try { return await operation; }
  finally { if (running.get(key) === operation) running.delete(key); }

  async function perform() {
    const fence = () => accountFence(access), train = clientFor(access, fence);
    input.signal.throwIfAborted();
    const prior = await input.store.getCacheEntry<unknown>(SCORES, key);
    let attempt = prior ? Attempt.parse(prior.payload) : null;
    if (attempt && (canonicalJson(attempt.source) !== canonicalJson(source) || attempt.chatRequestId !== requestId
      || attempt.scopeHash !== scopeHash || attempt.intentHash !== intentHash || canonicalJson(attempt.intent) !== canonicalJson(intent)))
      throw new Error("Recover the original Decision score without changing its input, account or saved version.");
    if (!attempt) {
      // A new chat turn can be the user's retry of an uncertain score. Find its
      // original journal entry before requiring a still-active mutable pool.
      let cursor: string | undefined;
      const cursors = new Set<string>();
      for (let pageNumber = 0; ; pageNumber++) {
        if (pageNumber >= 100) throw new Error("The retained scoring catalog exceeds its supported bound.");
        input.signal.throwIfAborted();
        const page = await input.store.pendingEvaluationOperations({ scopeHash, action: ACTION, cursor });
        const original = page.items.find(row => row.intentHash === intentHash && row.phase === "dispatching");
        if (original) {
          attempt = Attempt.parse({ source, chatRequestId: requestId, scopeHash, intentHash, intent,
            request: { ...intent.request, requestId: original.id }, receipt: null });
          await input.store.setCacheEntry(SCORES, key, attempt);
          break;
        }
        if (!page.nextCursor) break;
        if (cursors.has(page.nextCursor)) throw new Error("The retained scoring catalog repeated a page.");
        cursors.add(page.nextCursor); cursor = page.nextCursor;
      }
    }
    if (!attempt) {
      const serving = await train.decisionModelServing(source.modelProjectId,
        { teamId: source.teamId, versionHash: source.versionHash }, { signal: input.signal, ownerUserId: source.actorId });
      if (serving.state !== "active" || serving.availability.state !== "qualified"
        || serving.version.contentHash !== source.versionHash || serving.version.ownerUserId !== source.actorId)
        throw new Error("Enable qualified serving for this exact Decision Model before scoring.");
      const control = serving.control, ref = control?.binding;
      const binding = ref && serving.bindings.find(row => row.id === ref.id && row.revision === ref.revision
        && row.poolId === control?.poolId && row.versionHash === source.versionHash && row.modelId === `decision:model:${source.modelProjectId}`);
      const pool = binding && serving.pools.find(row => row.id === binding.poolId && row.state === "ready" && row.endpointRecorded);
      if (!control || control.actorId !== source.actorId || control.versionHash !== source.versionHash
        || control.desiredState !== "active" || control.phase !== "active" || !pool?.workerImageDigest || !serving.availability.runtimeHash)
        throw new Error("This Decision Model has no verified active serving binding.");
      await fence(); input.signal.throwIfAborted();
      const prepared = await input.store.prepareEvaluationOperation({ scopeHash, action: ACTION, intentHash, reviewedIntent: intent });
      attempt = Attempt.parse({ source, chatRequestId: requestId, scopeHash, intentHash, intent,
        request: { ...intent.request, requestId: prepared.id }, receipt: null });
      await input.store.setCacheEntry(SCORES, key, attempt);
    }
    const command = { modelProjectId: source.modelProjectId, request: attempt.request };
    validateReviewedEvaluationCommand({ action: ACTION, id: attempt.request.requestId, actorId: source.actorId,
      teamId: source.teamId, projectId: null, intent: attempt.intent, command });
    const scope = { scopeHash, action: ACTION, intentHash, id: attempt.request.requestId };
    const retained = await input.store.readPendingEvaluationOperation(scope);
    if (contentHash(retained.reviewedIntent) !== intentHash || retained.command && contentHash(retained.command) !== contentHash(command))
      throw new Error("The original Decision scoring journal differs from this chat request.");
    await fence(); input.signal.throwIfAborted();
    let receipt = attempt.receipt;
    if (!receipt) {
      await input.store.retainEvaluationOperation({ ...scope, command, phase: "dispatching" });
      await fence(); input.signal.throwIfAborted();
      // The typed API owner reconciles this original request before fresh
      // mutable admission. A transport error never creates another operation.
      receipt = await train.scoreDecisionModel(source.modelProjectId, attempt.request,
        { actorId: source.actorId, signal: AbortSignal.any([input.signal, AbortSignal.timeout(330_000)]) });
    }
    receipt = await parseAndVerifyDecisionModelScoreReceipt(receipt,
      { modelProjectId: source.modelProjectId, request: attempt.request, actorId: source.actorId });
    await fence();
    await input.store.setCacheEntry(SCORES, key, { ...attempt, receipt });
    await fence();
    return receipt;
  }
}

/** Acknowledge only after the consumer has retained the score in chat history.
 * If delivery stops first, a retry in a new turn still recovers the same paid
 * operation through the existing journal rather than creating another score. */
export async function acknowledgeManagedDecisionChatScore(input: {
  store: SqliteStore; modelId: string; requestId: string; receipt: DecisionModelScoreReceipt;
}) {
  if (!isManagedDecisionChatModel(input.modelId)) throw new Error("Select the original saved Decision Model.");
  const hash = Hash.parse(input.modelId.slice(PREFIX.length));
  const locator = await input.store.getCacheEntry<unknown>(LOCATORS, hash);
  if (!locator) throw new Error("The original Decision Model locator is unavailable.");
  const source = Source.parse(locator.payload), access = await configuredAccess(source.teamId);
  if (await canonicalSha256(source) !== hash || canonicalJson(identity(access)) !== canonicalJson({ teamId: source.teamId, actorId: source.actorId, apiOrigin: source.apiOrigin }))
    throw new Error("Return to this score's original account and saved version.");
  const key = await canonicalSha256({ source, requestId: input.requestId });
  const cached = await input.store.getCacheEntry<unknown>(SCORES, key);
  const attempt = Attempt.parse(cached?.payload);
  if (canonicalJson(attempt.source) !== canonicalJson(source) || attempt.chatRequestId !== input.requestId
    || attempt.scopeHash !== contentHash({ ...identity(access), projectId: null }) || attempt.intentHash !== contentHash(attempt.intent)
    || canonicalJson(attempt.intent.account) !== canonicalJson(identity(access)) || attempt.intent.modelProjectId !== source.modelProjectId
    || attempt.request.versionHash !== source.versionHash
    || !attempt.receipt || canonicalJson(attempt.receipt) !== canonicalJson(input.receipt))
    throw new Error("The delivered score differs from its original retained request.");
  validateReviewedEvaluationCommand({ action: ACTION, id: attempt.request.requestId, actorId: source.actorId,
    teamId: source.teamId, projectId: null, intent: attempt.intent,
    command: { modelProjectId: source.modelProjectId, request: attempt.request } });
  await accountFence(access);
  await input.store.acknowledgeEvaluationOperation({ scopeHash: attempt.scopeHash, action: ACTION,
    intentHash: attempt.intentHash, id: attempt.request.requestId });
  await accountFence(access);
}

/** These are the complete verified candidate distributions, not generated text
 * or an inferred answer from an unrelated chat model. */
export function decisionChatScoreText(receipt: DecisionModelScoreReceipt) {
  const escape = (value: unknown) => String(value).replace(/[\\`*_[\]<>|]/g, character => `\\${character}`).replace(/[\r\n]+/g, " ");
  return receipt.result.distributions.map(row => [
    `**${escape(row.questionId)}**`, `Selected answer: ${escape(row.prediction)}`,
    ...(row.expectedLevel === null ? [] : [`Expected level: ${row.expectedLevel.toFixed(4)}`]),
    "", "| Answer | Probability |", "| --- | ---: |",
    ...row.candidates.map(candidate => `| ${escape(candidate.value)} | ${(candidate.probability * 100).toFixed(4)}% |`),
  ].join("\n")).join("\n\n");
}
