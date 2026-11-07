import { canonicalComputeSpendCap, managedModificationPriceApprovalMatches } from "./managed-compute-price.js";
import { z } from "zod";
import { canonicalJson, canonicalSha256, OpenPondProtocolError } from "./protocol.js";
import { ModelModificationCapabilitiesQuerySchema, ModelModificationValidationLevelSchema, assertModelModificationValidationLevel } from "./model-modification-capabilities.js";
import { ManagedModificationExecutionMetadataSchema, ManagedModificationStartSchema, ManagedModificationCancelSchema,
   parseManagedModificationControl } from "./managed-modification-executions.js";
import { NeuronTrainingRequestSchema, NeuronTrainingSettingsSchema, NeuronTrainingSelectionSchema,
  parseAndVerifyNeuronTrainingRequest } from "./neuron-training.js";
import { NeuronTrainingResultSchema, parseAndVerifyNeuronTrainingResult } from "./neuron-training-result.js";
import { NeuronTrainingExperimentFormDraftSchema } from "./neuron-training-experiment-draft.js";
import { NeuronSteeringModelSchema } from "./neuron-steering.js";

const Id = z.string().trim().min(1).max(240), Hash = z.string().regex(/^[a-f0-9]{64}$/);
const Money = z.string().regex(/^(0|[1-9]\d*)(\.\d{1,6})?$/).max(48);
const Method = z.literal("selective_neuron_training");
const Query = ModelModificationCapabilitiesQuerySchema;
export const NeuronTrainingExecutionCapabilityContentSchema = z.object({
  schemaVersion: z.literal("openpond.neuronTrainingExecutionCapability.v1"),
  teamId: Id, actorId: Id, query: Query, requestHash: Hash,
  checkedAt: z.iso.datetime(), expiresAt: z.iso.datetime(),
  validationLevel: ModelModificationValidationLevelSchema.nullable(),
  execution: z.discriminatedUnion("state", [
    z.object({state: z.literal("unavailable"), code: z.enum(["model_not_supported", "runtime_not_qualified"]), reason: z.string().min(1).max(1000)}).strict(),
    z.object({state: z.literal("ready"), model: NeuronSteeringModelSchema,
      continuation: z.literal("frozen_parent_fresh_residual_adam_v1").optional(),
      runtime: z.object({id: Id, releaseHash: Hash, imageDigest: z.string().regex(/^sha256:[a-f0-9]{64}$/),
        requestSchema: z.literal("openpond.selectiveNeuronTrainingRequest.v1"), evidence: z.object({id: Id, contentHash: Hash}).strict()}).strict(),
      limits: z.object({maximumExamples: z.number().int().min(1).max(4096), maximumDataBytes: z.number().int().positive().max(8_388_608),
        maximumSteps: z.number().int().min(1).max(128), maximumSequenceLength: z.number().int().min(2).max(8192),
        maximumDurationSeconds: z.number().finite().min(1).max(21_600), maximumCheckpointBytes: z.number().int().positive().max(16_777_216)}).strict(),
    }).strict(),
  ]),
}).strict();
export const NeuronTrainingExecutionCapabilitySchema = NeuronTrainingExecutionCapabilityContentSchema.extend({contentHash: Hash});
export type NeuronTrainingExecutionCapability = z.infer<typeof NeuronTrainingExecutionCapabilitySchema>;

export const ManagedNeuronTrainingCompileSchema = z.object({teamId: Id, projectId: Id.nullable(), method: Method,
  query: Query, form: NeuronTrainingExperimentFormDraftSchema}).strict();
export type ManagedNeuronTrainingCompile = z.infer<typeof ManagedNeuronTrainingCompileSchema>;
export const ManagedNeuronTrainingCompilationContentSchema = z.object({
  schemaVersion: z.literal("openpond.managedNeuronTrainingCompilation.v1"), teamId: Id, actorId: Id,
  projectId: Id.nullable(), method: Method, query: Query, formHash: Hash, inputHash: Hash,
  request: NeuronTrainingRequestSchema,
}).strict();
export const ManagedNeuronTrainingCompilationSchema = ManagedNeuronTrainingCompilationContentSchema.extend({contentHash: Hash});
export type ManagedNeuronTrainingCompilation = z.infer<typeof ManagedNeuronTrainingCompilationSchema>;
export const ManagedNeuronTrainingPrepareSchema = z.object({teamId: Id, operationId: Id, projectId: Id.nullable(),
  name: z.string().trim().min(1).max(500), method: Method, query: Query,
  request: NeuronTrainingRequestSchema, maximumSpendUsd: Money.nullish(), sourceForm: NeuronTrainingExperimentFormDraftSchema.optional()}).strict();
export type ManagedNeuronTrainingPrepare = z.infer<typeof ManagedNeuronTrainingPrepareSchema>;
export const ManagedNeuronTrainingStartSchema = ManagedModificationStartSchema;
export const ManagedNeuronTrainingCancelSchema = ManagedModificationCancelSchema;
export type ManagedNeuronTrainingStart = z.infer<typeof ManagedNeuronTrainingStartSchema>;
export type ManagedNeuronTrainingCancel = z.infer<typeof ManagedNeuronTrainingCancelSchema>;
export const ManagedNeuronTrainingExecutionMetadataSchema = ManagedModificationExecutionMetadataSchema.omit({method: true}).extend({method: Method}).strict();
export const ManagedNeuronTrainingExecutionContentSchema = ManagedNeuronTrainingExecutionMetadataSchema.extend({
  schemaVersion: z.literal("openpond.managedNeuronTrainingExecution.v1"), request: NeuronTrainingRequestSchema,
  sourceForm: NeuronTrainingExperimentFormDraftSchema.optional(), result: NeuronTrainingResultSchema.nullable(),
  resultRecordedAt: z.iso.datetime().nullable(),
}).strict();
export const ManagedNeuronTrainingExecutionSchema = ManagedNeuronTrainingExecutionContentSchema.extend({contentHash: Hash});
export type ManagedNeuronTrainingExecution = z.infer<typeof ManagedNeuronTrainingExecutionSchema>;
export const ManagedNeuronTrainingExecutionReceiptContentSchema = z.object({
  schemaVersion: z.literal("openpond.managedNeuronTrainingExecutionReceipt.v1"), operationId: Id, requestHash: Hash,
  execution: ManagedNeuronTrainingExecutionMetadataSchema,
}).strict();
export const ManagedNeuronTrainingExecutionReceiptSchema = ManagedNeuronTrainingExecutionReceiptContentSchema.extend({contentHash: Hash});
export type ManagedNeuronTrainingExecutionReceipt = z.infer<typeof ManagedNeuronTrainingExecutionReceiptSchema>;
export const ManagedNeuronTrainingExecutionListQuerySchema = z.object({
  method: Method.default("selective_neuron_training"), id: Id.optional(), projectId: Id.optional(),
  phase: ManagedNeuronTrainingExecutionMetadataSchema.shape.phase.optional(),
  limit: z.number().int().min(1).max(100).default(25), cursor: z.string().min(1).max(2048).optional(),
}).strict();
export type ManagedNeuronTrainingExecutionListQuery = z.input<typeof ManagedNeuronTrainingExecutionListQuerySchema>;
export const ManagedNeuronTrainingExecutionSummarySchema = ManagedNeuronTrainingExecutionMetadataSchema.extend({model: NeuronSteeringModelSchema}).strict();
export const ManagedNeuronTrainingExecutionPageContentSchema = z.object({
  schemaVersion: z.literal("openpond.managedNeuronTrainingExecutionPage.v1"), teamId: Id, ownerUserId: Id,
  query: ManagedNeuronTrainingExecutionListQuerySchema, items: z.array(ManagedNeuronTrainingExecutionSummarySchema).max(100),
  nextCursor: z.string().min(1).max(2048).nullable(),
}).strict();
export const ManagedNeuronTrainingExecutionPageSchema = ManagedNeuronTrainingExecutionPageContentSchema.extend({contentHash: Hash});
export type ManagedNeuronTrainingExecutionPage = z.infer<typeof ManagedNeuronTrainingExecutionPageSchema>;

export function parseNeuronTrainingFormTraining(raw: z.infer<typeof NeuronTrainingExperimentFormDraftSchema>["training"]) {
  const fields = Object.entries(raw).map(([key, value]) => {
    if (!value.trim()) throw new OpenPondProtocolError("neuron_training_training_settings_missing", "Complete each NeuronTraining training setting before preparing.");
    return [key, Number(value)] as const;
  });
  return NeuronTrainingSettingsSchema.parse(Object.fromEntries(fields));
}
function fail(): never {
  throw new OpenPondProtocolError("neuron_training_execution_mismatch", "The NeuronTraining operation differs from its exact model, data, settings or original approval.");
}
function checkSource(query: z.infer<typeof Query>, request: Pick<z.infer<typeof NeuronTrainingRequestSchema>, "model">) {
  if (query.source !== "managed" || query.modelAssetId !== undefined || !query.revision || !query.tokenizerRevision
    || query.modelId !== request.model.modelId || query.revision !== request.model.revision) fail();
}
export function parseNeuronTrainingFormSelection(form: z.infer<typeof NeuronTrainingExperimentFormDraftSchema>["selection"]) {
  if (![form.count, form.maximumBackgroundTargetRatio, form.gradientExamples].every(value => value.trim()))
    throw new OpenPondProtocolError("neuron_training_selection_missing", "Complete the neuron selection settings.");
  const lines = form.coordinates.trim() ? form.coordinates.trim().split(/\r?\n/) : null;
  if (lines?.some(line => !/^\s*\d+\s*:\s*\d+\s*$/.test(line)))
    throw new OpenPondProtocolError("neuron_training_coordinates_invalid", "Enter one layer:neuron coordinate per line.");
  const explicitCoordinates = lines?.map(line => {const [layer, neuron] = line.split(":").map(Number); return {layer, neuron};}) ?? null;
  return NeuronTrainingSelectionSchema.parse({count: Number(form.count), span: form.span,
    backgroundStatistic: form.backgroundStatistic, maximumBackgroundTargetRatio: Number(form.maximumBackgroundTargetRatio),
    gradientExamples: Number(form.gradientExamples), explicitCoordinates});
}
async function checkForm(form: z.infer<typeof NeuronTrainingExperimentFormDraftSchema>, request: z.infer<typeof NeuronTrainingRequestSchema>) {
  if (!form.baseModel || form.baseModel.modelId !== request.model.modelId || form.baseModel.revision !== request.model.revision
    || canonicalJson(form.targetBatch) !== canonicalJson(request.data.target.batch)
    || canonicalJson(form.background.map(row => ({domain: row.domain.trim(), batch: row.batch})))
      !== canonicalJson(request.data.background.map(row => ({domain: row.domain, batch: row.batch})))
    || canonicalJson(form.preservationBatch) !== canonicalJson(request.data.preservation?.batch ?? null)
    || canonicalJson(form.parentArtifact) !== canonicalJson(request.parentArtifact)
    || canonicalJson(parseNeuronTrainingFormSelection(form.selection)) !== canonicalJson(request.selection)
    || canonicalJson(parseNeuronTrainingFormTraining(form.training)) !== canonicalJson(request.training)) fail();
  if (form.startingModule && (!request.parentArtifact
    || canonicalJson(form.startingModule.artifact) !== canonicalJson({id: request.parentArtifact.id, contentHash: request.parentArtifact.contentHash})
    || form.startingModule.modelHash !== await canonicalSha256(request.model))) fail();
  if (form.inspectionSource && (request.parentArtifact !== null || !request.selection.explicitCoordinates
    || form.inspectionSource.modelHash !== await canonicalSha256(request.model))) fail();
}
function checkFormQuery(form: z.infer<typeof NeuronTrainingExperimentFormDraftSchema>, query: z.infer<typeof Query>) {
  const base = {schemaVersion: "openpond.baseModelPreference.v1", modelId: query.modelId, source: query.source,
    revision: query.revision ?? null, tokenizerRevision: query.tokenizerRevision ?? null,
    chatTemplateHash: query.chatTemplateHash ?? null, modelAssetId: query.modelAssetId ?? null};
  if (canonicalJson(form.baseModel) !== canonicalJson(base)) fail();
}
export async function parseAndVerifyNeuronTrainingExecutionCapability(raw: unknown, queryInput: z.infer<typeof Query>, actorId?: string) {
  const query = Query.parse(queryInput), value = NeuronTrainingExecutionCapabilitySchema.parse(raw), {contentHash, ...content} = value;
  assertModelModificationValidationLevel(value.execution, value.validationLevel);
  const checked = Date.parse(value.checkedAt), expires = Date.parse(value.expiresAt);
  if (value.teamId !== query.teamId || actorId !== undefined && value.actorId !== actorId
    || canonicalJson(value.query) !== canonicalJson(query) || value.requestHash !== await canonicalSha256(query)
    || contentHash !== await canonicalSha256(content) || checked > Date.now() + 30_000
    || expires <= Date.now() || expires <= checked || expires - checked > 300_000) fail();
  if (value.execution.state === "ready") checkSource(query, {model: value.execution.model});
  return value;
}
export async function parseAndVerifyManagedNeuronTrainingCompilation(raw: unknown, input: ManagedNeuronTrainingCompile) {
  const command = ManagedNeuronTrainingCompileSchema.parse(input), value = ManagedNeuronTrainingCompilationSchema.parse(raw), {contentHash, ...content} = value;
  const request = await parseAndVerifyNeuronTrainingRequest(value.request);
  checkSource(command.query, request); await checkForm(command.form, request); checkFormQuery(command.form, command.query);
  if (contentHash !== await canonicalSha256(content) || value.teamId !== command.teamId || command.query.teamId !== command.teamId
    || value.projectId !== command.projectId || canonicalJson(value.query) !== canonicalJson(command.query)
    || value.formHash !== await canonicalSha256(command.form) || value.inputHash !== await canonicalSha256(request)) fail();
  return value;
}
export async function parseAndVerifyManagedNeuronTrainingExecution(raw: unknown, expected: {teamId: string; id: string; ownerUserId?: string}) {
  const value = ManagedNeuronTrainingExecutionSchema.parse(raw), {contentHash, ...content} = value;
  const request = await parseAndVerifyNeuronTrainingRequest(value.request);
  if (contentHash !== await canonicalSha256(content) || value.teamId !== expected.teamId || value.id !== expected.id
    || expected.ownerUserId !== undefined && value.ownerUserId !== expected.ownerUserId
    || value.plan.inputHash !== await canonicalSha256(request)
    || value.result === null && value.resultRecordedAt !== null || value.result !== null && value.resultRecordedAt === null) fail();
  if (value.sourceForm) await checkForm(value.sourceForm, request);
  if (value.result) await parseAndVerifyNeuronTrainingResult(value.result, {request, runtimeHash: value.plan.runtimeHash});
  return value;
}
export async function parseAndVerifyManagedNeuronTrainingPrepare(raw: unknown) {
  const request = ManagedNeuronTrainingPrepareSchema.parse(raw);
  request.maximumSpendUsd = canonicalComputeSpendCap(request.maximumSpendUsd);
  await parseAndVerifyNeuronTrainingRequest(request.request);
  checkSource(request.query, request.request);
  if (request.query.teamId !== request.teamId) fail();
  if (request.sourceForm) {
    await checkForm(request.sourceForm, request.request); checkFormQuery(request.sourceForm, request.query);
    if (canonicalComputeSpendCap(request.sourceForm.maximumSpendUsd) !== request.maximumSpendUsd) fail();
  }
  return request;
}
export async function parseAndVerifyManagedNeuronTrainingExecutionReceipt(raw: unknown, command: ManagedNeuronTrainingPrepare | ManagedNeuronTrainingStart | ManagedNeuronTrainingCancel) {
  const request = "action" in command ? parseManagedModificationControl(command) : await parseAndVerifyManagedNeuronTrainingPrepare(command);
  const value = ManagedNeuronTrainingExecutionReceiptSchema.parse(raw), {contentHash, ...content} = value;
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
    await parseAndVerifyNeuronTrainingRequest(request.request); checkSource(request.query, request.request);
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
function parseExecutionListQuery(raw: ManagedNeuronTrainingExecutionListQuery = {}) {
  const query = ManagedNeuronTrainingExecutionListQuerySchema.parse(raw);
  return ManagedNeuronTrainingExecutionListQuerySchema.parse(Object.fromEntries(
    Object.entries(query).filter(([, value]) => value !== undefined),
  ));
}

export async function parseAndVerifyManagedNeuronTrainingExecutionPage(raw: unknown, expected: {
  teamId: string; ownerUserId?: string; query?: ManagedNeuronTrainingExecutionListQuery;
}) {
  const value = ManagedNeuronTrainingExecutionPageSchema.parse(raw), {contentHash, ...content} = value;
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
 * NeuronTraining parsing never coerces a module into an activation or LoRA result. */
export function createManagedNeuronTrainingExecutionClient(request: (path: string, init?: RequestInit) => Promise<unknown>) {
  const root = "/v1/training/modification-executions";
  return {
    async neuronTrainingExecutionCapability(raw: z.infer<typeof Query>, options?: {signal?: AbortSignal}) {
      const query = Query.parse(raw);
      return parseAndVerifyNeuronTrainingExecutionCapability(await request(`/v1/training/modification-capabilities/neuron-training?${params(query)}`, options), query);
    },
    async compileNeuronTrainingExecution(raw: ManagedNeuronTrainingCompile) {
      const command = ManagedNeuronTrainingCompileSchema.parse(raw);
      return parseAndVerifyManagedNeuronTrainingCompilation(await request(`${root}/compile`, {method: "POST", body: canonicalJson(command)}), command);
    },
    async prepareNeuronTrainingExecution(raw: ManagedNeuronTrainingPrepare) {
      const command = await parseAndVerifyManagedNeuronTrainingPrepare(raw);
      return parseAndVerifyManagedNeuronTrainingExecutionReceipt(await request(`${root}/prepare`, {method: "POST", body: canonicalJson(command)}), command);
    },
    async startNeuronTrainingExecution(raw: ManagedNeuronTrainingStart) {
      const command = parseManagedModificationControl(ManagedNeuronTrainingStartSchema.parse(raw));
      return parseAndVerifyManagedNeuronTrainingExecutionReceipt(await request(`${root}/${encodeURIComponent(command.id)}/start`, {method: "POST", body: canonicalJson(command)}), command);
    },
    async cancelNeuronTrainingExecution(raw: ManagedNeuronTrainingCancel) {
      const command = ManagedNeuronTrainingCancelSchema.parse(raw);
      return parseAndVerifyManagedNeuronTrainingExecutionReceipt(await request(`${root}/${encodeURIComponent(command.id)}/cancel`, {method: "POST", body: canonicalJson(command)}), command);
    },
    async getNeuronTrainingExecution(teamId: string, id: string, options?: {signal?: AbortSignal; ownerUserId?: string}) {
      const scope = {teamId: Id.parse(teamId), id: Id.parse(id), ownerUserId: options?.ownerUserId};
      return parseAndVerifyManagedNeuronTrainingExecution(await request(`${root}/${encodeURIComponent(scope.id)}?${params({teamId: scope.teamId})}`, {signal: options?.signal}), scope);
    },
    async listNeuronTrainingExecutions(teamId: string, raw: ManagedNeuronTrainingExecutionListQuery = {}, options?: {signal?: AbortSignal; ownerUserId?: string}) {
      const team = Id.parse(teamId), query = parseExecutionListQuery(raw);
      return parseAndVerifyManagedNeuronTrainingExecutionPage(await request(`${root}?${params({teamId: team, ...query})}`, {signal: options?.signal}), {teamId: team, query, ownerUserId: options?.ownerUserId});
    },
  };
}
