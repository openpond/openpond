import { canonicalComputeSpendCap, managedModificationPriceApprovalMatches } from "./managed-compute-price.js";
import { z } from "zod";
import { canonicalJson, canonicalSha256, OpenPondProtocolError } from "./protocol.js";
import { ModelModificationCapabilitiesQuerySchema, ModelModificationValidationLevelSchema, assertModelModificationValidationLevel } from "./model-modification-capabilities.js";
import { ManagedModificationExecutionMetadataSchema, ManagedModificationStartSchema, ManagedModificationCancelSchema,
   parseManagedModificationControl } from "./managed-modification-executions.js";
import { EngramAdapterConfigSchema, EngramTrainingRequestSchema, EngramTrainingResultSchema,
  EngramTrainingSettingsSchema, parseAndVerifyEngramTrainingRequest, parseAndVerifyEngramTrainingResult } from "./engram-adapter.js";
import { EngramExperimentFormDraftSchema } from "./engram-experiment-draft.js";
import { NeuronSteeringModelSchema } from "./neuron-steering.js";

const Id = z.string().trim().min(1).max(240), Hash = z.string().regex(/^[a-f0-9]{64}$/);
const Money = z.string().regex(/^(0|[1-9]\d*)(\.\d{1,6})?$/).max(48);
const Method = z.literal("engram_adapter");
const Query = ModelModificationCapabilitiesQuerySchema;
export const EngramExecutionCapabilityContentSchema = z.object({
  schemaVersion: z.literal("openpond.engramExecutionCapability.v1"),
  teamId: Id, actorId: Id, query: Query, requestHash: Hash,
  checkedAt: z.iso.datetime(), expiresAt: z.iso.datetime(),
  validationLevel: ModelModificationValidationLevelSchema.nullable(),
  execution: z.discriminatedUnion("state", [
    z.object({state: z.literal("unavailable"), code: z.enum(["model_not_supported", "runtime_not_qualified"]), reason: z.string().min(1).max(1000)}).strict(),
    z.object({state: z.literal("ready"), model: NeuronSteeringModelSchema, config: EngramAdapterConfigSchema,
      runtime: z.object({id: Id, releaseHash: Hash, imageDigest: z.string().regex(/^sha256:[a-f0-9]{64}$/),
        requestSchema: z.literal("openpond.engramTrainingRequest.v1"), evidence: z.object({id: Id, contentHash: Hash}).strict()}).strict(),
      limits: z.object({maximumExamples: z.number().int().min(1).max(1000), maximumDataBytes: z.number().int().positive().max(8_388_608),
        maximumSteps: z.number().int().min(1).max(128), maximumSequenceLength: z.number().int().min(2).max(8192),
        maximumDurationSeconds: z.number().finite().min(1).max(21_600), maximumCheckpointBytes: z.number().int().positive().max(2_147_483_648)}).strict(),
    }).strict(),
  ]),
}).strict();
export const EngramExecutionCapabilitySchema = EngramExecutionCapabilityContentSchema.extend({contentHash: Hash});
export type EngramExecutionCapability = z.infer<typeof EngramExecutionCapabilitySchema>;

export const ManagedEngramCompileSchema = z.object({teamId: Id, projectId: Id.nullable(), method: Method,
  query: Query, form: EngramExperimentFormDraftSchema}).strict();
export type ManagedEngramCompile = z.infer<typeof ManagedEngramCompileSchema>;
export const ManagedEngramCompilationContentSchema = z.object({
  schemaVersion: z.literal("openpond.managedEngramCompilation.v1"), teamId: Id, actorId: Id,
  projectId: Id.nullable(), method: Method, query: Query, formHash: Hash, inputHash: Hash,
  request: EngramTrainingRequestSchema,
}).strict();
export const ManagedEngramCompilationSchema = ManagedEngramCompilationContentSchema.extend({contentHash: Hash});
export type ManagedEngramCompilation = z.infer<typeof ManagedEngramCompilationSchema>;
export const ManagedEngramPrepareSchema = z.object({teamId: Id, operationId: Id, projectId: Id.nullable(),
  name: z.string().trim().min(1).max(500), method: Method, query: Query,
  request: EngramTrainingRequestSchema, maximumSpendUsd: Money.nullish(), sourceForm: EngramExperimentFormDraftSchema.optional()}).strict();
export type ManagedEngramPrepare = z.infer<typeof ManagedEngramPrepareSchema>;
export const ManagedEngramStartSchema = ManagedModificationStartSchema;
export const ManagedEngramCancelSchema = ManagedModificationCancelSchema;
export type ManagedEngramStart = z.infer<typeof ManagedEngramStartSchema>;
export type ManagedEngramCancel = z.infer<typeof ManagedEngramCancelSchema>;
export const ManagedEngramExecutionMetadataSchema = ManagedModificationExecutionMetadataSchema.omit({method: true}).extend({method: Method}).strict();
export const ManagedEngramExecutionContentSchema = ManagedEngramExecutionMetadataSchema.extend({
  schemaVersion: z.literal("openpond.managedEngramExecution.v1"), request: EngramTrainingRequestSchema,
  sourceForm: EngramExperimentFormDraftSchema.optional(), result: EngramTrainingResultSchema.nullable(),
  resultRecordedAt: z.iso.datetime().nullable(),
}).strict();
export const ManagedEngramExecutionSchema = ManagedEngramExecutionContentSchema.extend({contentHash: Hash});
export type ManagedEngramExecution = z.infer<typeof ManagedEngramExecutionSchema>;
export const ManagedEngramExecutionReceiptContentSchema = z.object({
  schemaVersion: z.literal("openpond.managedEngramExecutionReceipt.v1"), operationId: Id, requestHash: Hash,
  execution: ManagedEngramExecutionMetadataSchema,
}).strict();
export const ManagedEngramExecutionReceiptSchema = ManagedEngramExecutionReceiptContentSchema.extend({contentHash: Hash});
export type ManagedEngramExecutionReceipt = z.infer<typeof ManagedEngramExecutionReceiptSchema>;
export const ManagedEngramExecutionListQuerySchema = z.object({
  method: Method.default("engram_adapter"), id: Id.optional(), projectId: Id.optional(),
  phase: ManagedEngramExecutionMetadataSchema.shape.phase.optional(),
  limit: z.number().int().min(1).max(100).default(25), cursor: z.string().min(1).max(2048).optional(),
}).strict();
export type ManagedEngramExecutionListQuery = z.input<typeof ManagedEngramExecutionListQuerySchema>;
export const ManagedEngramExecutionSummarySchema = ManagedEngramExecutionMetadataSchema.extend({model: NeuronSteeringModelSchema}).strict();
export const ManagedEngramExecutionPageContentSchema = z.object({
  schemaVersion: z.literal("openpond.managedEngramExecutionPage.v1"), teamId: Id, ownerUserId: Id,
  query: ManagedEngramExecutionListQuerySchema, items: z.array(ManagedEngramExecutionSummarySchema).max(100),
  nextCursor: z.string().min(1).max(2048).nullable(),
}).strict();
export const ManagedEngramExecutionPageSchema = ManagedEngramExecutionPageContentSchema.extend({contentHash: Hash});
export type ManagedEngramExecutionPage = z.infer<typeof ManagedEngramExecutionPageSchema>;

export function parseEngramFormTraining(raw: z.infer<typeof EngramExperimentFormDraftSchema>["training"]) {
  const fields = Object.entries(raw).map(([key, value]) => {
    if (!value.trim()) throw new OpenPondProtocolError("engram_training_settings_missing", "Complete each Engram training setting before preparing.");
    return [key, Number(value)] as const;
  });
  return EngramTrainingSettingsSchema.parse(Object.fromEntries(fields));
}
function fail(): never {
  throw new OpenPondProtocolError("engram_execution_mismatch", "The Engram operation differs from its exact model, data, settings or original approval.");
}
function checkSource(query: z.infer<typeof Query>, request: Pick<z.infer<typeof EngramTrainingRequestSchema>, "model">) {
  if (query.source !== "managed" || query.modelAssetId !== undefined || !query.revision || !query.tokenizerRevision
    || query.modelId !== request.model.modelId || query.revision !== request.model.revision) fail();
}
async function checkForm(form: z.infer<typeof EngramExperimentFormDraftSchema>, request: z.infer<typeof EngramTrainingRequestSchema>) {
  if (!form.baseModel || form.baseModel.modelId !== request.model.modelId || form.baseModel.revision !== request.model.revision
    || canonicalJson(form.batch) !== canonicalJson(request.data.batch)
    || canonicalJson(parseEngramFormTraining(form.training)) !== canonicalJson(request.training)
    || canonicalJson(form.parentArtifact) !== canonicalJson(request.parentArtifact)) fail();
  if (form.startingModule && (canonicalJson(form.startingModule.artifact) !== canonicalJson(request.parentArtifact)
    || form.startingModule.modelHash !== await canonicalSha256(request.model))) fail();
}
function checkFormQuery(form: z.infer<typeof EngramExperimentFormDraftSchema>, query: z.infer<typeof Query>) {
  const base = {schemaVersion: "openpond.baseModelPreference.v1", modelId: query.modelId, source: query.source,
    revision: query.revision ?? null, tokenizerRevision: query.tokenizerRevision ?? null,
    chatTemplateHash: query.chatTemplateHash ?? null, modelAssetId: query.modelAssetId ?? null};
  if (canonicalJson(form.baseModel) !== canonicalJson(base)) fail();
}
export async function parseAndVerifyEngramExecutionCapability(raw: unknown, queryInput: z.infer<typeof Query>, actorId?: string) {
  const query = Query.parse(queryInput), value = EngramExecutionCapabilitySchema.parse(raw), {contentHash, ...content} = value;
  assertModelModificationValidationLevel(value.execution, value.validationLevel);
  const checked = Date.parse(value.checkedAt), expires = Date.parse(value.expiresAt);
  if (value.teamId !== query.teamId || actorId !== undefined && value.actorId !== actorId
    || canonicalJson(value.query) !== canonicalJson(query) || value.requestHash !== await canonicalSha256(query)
    || contentHash !== await canonicalSha256(content) || checked > Date.now() + 30_000
    || expires <= Date.now() || expires <= checked || expires - checked > 300_000) fail();
  if (value.execution.state === "ready") checkSource(query, {model: value.execution.model});
  return value;
}
export async function parseAndVerifyManagedEngramCompilation(raw: unknown, input: ManagedEngramCompile) {
  const command = ManagedEngramCompileSchema.parse(input), value = ManagedEngramCompilationSchema.parse(raw), {contentHash, ...content} = value;
  const request = await parseAndVerifyEngramTrainingRequest(value.request);
  checkSource(command.query, request); await checkForm(command.form, request); checkFormQuery(command.form, command.query);
  if (contentHash !== await canonicalSha256(content) || value.teamId !== command.teamId || command.query.teamId !== command.teamId
    || value.projectId !== command.projectId || canonicalJson(value.query) !== canonicalJson(command.query)
    || value.formHash !== await canonicalSha256(command.form) || value.inputHash !== await canonicalSha256(request)) fail();
  return value;
}
export async function parseAndVerifyManagedEngramExecution(raw: unknown, expected: {teamId: string; id: string; ownerUserId?: string}) {
  const value = ManagedEngramExecutionSchema.parse(raw), {contentHash, ...content} = value;
  const request = await parseAndVerifyEngramTrainingRequest(value.request);
  if (contentHash !== await canonicalSha256(content) || value.teamId !== expected.teamId || value.id !== expected.id
    || expected.ownerUserId !== undefined && value.ownerUserId !== expected.ownerUserId
    || value.plan.inputHash !== await canonicalSha256(request)
    || value.result === null && value.resultRecordedAt !== null || value.result !== null && value.resultRecordedAt === null) fail();
  if (value.sourceForm) await checkForm(value.sourceForm, request);
  if (value.result) await parseAndVerifyEngramTrainingResult(value.result, {request, runtimeHash: value.plan.runtimeHash});
  return value;
}
export async function parseAndVerifyManagedEngramPrepare(raw: unknown) {
  const request = ManagedEngramPrepareSchema.parse(raw);
  request.maximumSpendUsd = canonicalComputeSpendCap(request.maximumSpendUsd);
  await parseAndVerifyEngramTrainingRequest(request.request);
  checkSource(request.query, request.request);
  if (request.query.teamId !== request.teamId) fail();
  if (request.sourceForm) {
    await checkForm(request.sourceForm, request.request); checkFormQuery(request.sourceForm, request.query);
    if (canonicalComputeSpendCap(request.sourceForm.maximumSpendUsd) !== request.maximumSpendUsd) fail();
  }
  return request;
}
export async function parseAndVerifyManagedEngramExecutionReceipt(raw: unknown, command: ManagedEngramPrepare | ManagedEngramStart | ManagedEngramCancel) {
  const request = "action" in command ? parseManagedModificationControl(command) : await parseAndVerifyManagedEngramPrepare(command);
  const value = ManagedEngramExecutionReceiptSchema.parse(raw), {contentHash, ...content} = value;
  if (contentHash !== await canonicalSha256(content) || value.operationId !== request.operationId
    || value.requestHash !== await canonicalSha256("action" in request ? request : {action: "prepare", command: request})
    || value.execution.teamId !== request.teamId
    || Date.parse(value.execution.plan.expiresAt) <= Date.parse(value.execution.plan.createdAt)
    || value.execution.plan.maximumSpendUsd !== canonicalComputeSpendCap(value.execution.plan.maximumSpendUsd)) fail();
  if ("action" in request) {
    if (value.execution.id !== request.id || value.execution.plan.contentHash !== request.planHash
      || value.execution.revision !== request.expectedRevision + 1
      || (request.action === "start" ? value.execution.phase !== "queued" || value.execution.plan.maximumSpendUsd !== request.approvedMaximumSpendUsd || !await managedModificationPriceApprovalMatches(value.execution.plan,request)
        : !["cancelled", "stopping"].includes(value.execution.phase))) fail();
  } else {
    await parseAndVerifyEngramTrainingRequest(request.request); checkSource(request.query, request.request);
    if (request.query.teamId !== request.teamId || value.execution.projectId !== request.projectId || value.execution.name !== request.name
      || value.execution.plan.inputHash !== await canonicalSha256(request.request)
      || value.execution.plan.maximumSpendUsd !== request.maximumSpendUsd
      || value.execution.phase !== "prepared" || value.execution.revision !== 1
      || value.execution.id !== `modification-${await canonicalSha256({teamId: request.teamId, ownerUserId: value.execution.ownerUserId, operationId: request.operationId})}`) fail();
    if (request.sourceForm) await checkForm(request.sourceForm, request.request);
  }
  return value;
}

/** Optional undefined properties are omission at the query boundary. Keep
 * canonical JSON strict, and retain schema defaults/validation for all values. */
function parseExecutionListQuery(raw: ManagedEngramExecutionListQuery = {}) {
  const query = ManagedEngramExecutionListQuerySchema.parse(raw);
  return ManagedEngramExecutionListQuerySchema.parse(Object.fromEntries(
    Object.entries(query).filter(([, value]) => value !== undefined),
  ));
}

export async function parseAndVerifyManagedEngramExecutionPage(raw: unknown, expected: {
  teamId: string; ownerUserId?: string; query?: ManagedEngramExecutionListQuery;
}) {
  const value = ManagedEngramExecutionPageSchema.parse(raw), {contentHash, ...content} = value;
  const query = parseExecutionListQuery(expected.query);
  if (contentHash !== await canonicalSha256(content) || value.teamId !== expected.teamId
    || expected.ownerUserId !== undefined && value.ownerUserId !== expected.ownerUserId
    || canonicalJson(value.query) !== canonicalJson(query) || value.items.length > query.limit
    || new Set(value.items.map(item => item.id)).size !== value.items.length) fail();
  for (const item of value.items) {
    if (item.teamId !== value.teamId || item.ownerUserId !== value.ownerUserId
      || query.id !== undefined && item.id !== query.id
      || query.projectId !== undefined && item.projectId !== query.projectId
      || query.phase !== undefined && item.phase !== query.phase
      || item.plan.maximumSpendUsd !== canonicalComputeSpendCap(item.plan.maximumSpendUsd)
      || Date.parse(item.plan.expiresAt) <= Date.parse(item.plan.createdAt)) fail();
  }
  return value;
}

function params(value: Record<string, unknown>) {
  const result = new URLSearchParams();
  for (const [key, item] of Object.entries(value)) if (item !== undefined) result.set(key, String(item));
  return result;
}
/** Uses the same configured transport and existing execution endpoints. Typed
 * Engram parsing never coerces a module into an activation or LoRA result. */
export function createManagedEngramExecutionClient(request: (path: string, init?: RequestInit) => Promise<unknown>) {
  const root = "/v1/training/modification-executions";
  return {
    async engramExecutionCapability(raw: z.infer<typeof Query>, options?: {signal?: AbortSignal}) {
      const query = Query.parse(raw);
      return parseAndVerifyEngramExecutionCapability(await request(`/v1/training/modification-capabilities/engram?${params(query)}`, options), query);
    },
    async compileEngramExecution(raw: ManagedEngramCompile) {
      const command = ManagedEngramCompileSchema.parse(raw);
      return parseAndVerifyManagedEngramCompilation(await request(`${root}/compile`, {method: "POST", body: canonicalJson(command)}), command);
    },
    async prepareEngramExecution(raw: ManagedEngramPrepare) {
      const command = await parseAndVerifyManagedEngramPrepare(raw);
      return parseAndVerifyManagedEngramExecutionReceipt(await request(`${root}/prepare`, {method: "POST", body: canonicalJson(command)}), command);
    },
    async startEngramExecution(raw: ManagedEngramStart) {
      const command = parseManagedModificationControl(ManagedEngramStartSchema.parse(raw));
      return parseAndVerifyManagedEngramExecutionReceipt(await request(`${root}/${encodeURIComponent(command.id)}/start`, {method: "POST", body: canonicalJson(command)}), command);
    },
    async cancelEngramExecution(raw: ManagedEngramCancel) {
      const command = ManagedEngramCancelSchema.parse(raw);
      return parseAndVerifyManagedEngramExecutionReceipt(await request(`${root}/${encodeURIComponent(command.id)}/cancel`, {method: "POST", body: canonicalJson(command)}), command);
    },
    async getEngramExecution(teamId: string, id: string, options?: {signal?: AbortSignal; ownerUserId?: string}) {
      const scope = {teamId: Id.parse(teamId), id: Id.parse(id), ownerUserId: options?.ownerUserId};
      return parseAndVerifyManagedEngramExecution(await request(`${root}/${encodeURIComponent(scope.id)}?${params({teamId: scope.teamId})}`, {signal: options?.signal}), scope);
    },
    async listEngramExecutions(teamId: string, raw: ManagedEngramExecutionListQuery = {}, options?: {signal?: AbortSignal; ownerUserId?: string}) {
      const team = Id.parse(teamId), query = parseExecutionListQuery(raw);
      return parseAndVerifyManagedEngramExecutionPage(await request(`${root}?${params({teamId: team, ...query})}`, {signal: options?.signal}), {teamId: team, query, ownerUserId: options?.ownerUserId});
    },
  };
}
