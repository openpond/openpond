import { canonicalComputeSpendCap, managedModificationPriceApprovalMatches } from "./managed-compute-price.js";
import { z } from "zod";
import { canonicalJson, canonicalSha256, OpenPondProtocolError } from "./protocol.js";
import { ModelModificationCapabilitiesQuerySchema, ModelModificationValidationLevelSchema, assertModelModificationValidationLevel } from "./model-modification-capabilities.js";
import { ManagedModificationExecutionMetadataSchema, ManagedModificationStartSchema, ManagedModificationCancelSchema,
   parseManagedModificationControl } from "./managed-modification-executions.js";
import { AlphaEditConfigSchema, AlphaEditTrainingRequestSchema, AlphaEditTrainingSettingsSchema,
  parseAndVerifyAlphaEditTrainingRequest } from "./alphaedit.js";
import { AlphaEditTrainingResultSchema, parseAndVerifyAlphaEditTrainingResult } from "./alphaedit-artifact.js";
import { AlphaEditExperimentFormDraftSchema, ALPHAEDIT_CONFIG_DEFAULTS } from "./alphaedit-experiment-draft.js";
import { NeuronSteeringModelSchema } from "./neuron-steering.js";

const Id = z.string().trim().min(1).max(240), Hash = z.string().regex(/^[a-f0-9]{64}$/);
const Money = z.string().regex(/^(0|[1-9]\d*)(\.\d{1,6})?$/).max(48);
const Method = z.literal("alphaedit");
const Query = ModelModificationCapabilitiesQuerySchema;
export const AlphaEditExecutionCapabilityContentSchema = z.object({
  schemaVersion: z.literal("openpond.alphaEditExecutionCapability.v1"),
  teamId: Id, actorId: Id, query: Query, requestHash: Hash,
  checkedAt: z.iso.datetime(), expiresAt: z.iso.datetime(),
  validationLevel: ModelModificationValidationLevelSchema.nullable(),
  execution: z.discriminatedUnion("state", [
    z.object({state: z.literal("unavailable"), code: z.enum(["model_not_supported", "runtime_not_qualified"]), reason: z.string().min(1).max(1000)}).strict(),
    z.object({state: z.literal("ready"), model: NeuronSteeringModelSchema,
      runtime: z.object({id: Id, releaseHash: Hash, imageDigest: z.string().regex(/^sha256:[a-f0-9]{64}$/),
        requestSchema: z.literal("openpond.alphaEditTrainingRequest.v1"), evidence: z.object({id: Id, contentHash: Hash}).strict()}).strict(),
      limits: z.object({maximumExamples: z.number().int().min(1).max(4096), maximumDataBytes: z.number().int().positive().max(8_388_608),
        maximumSteps: z.number().int().min(1).max(128), maximumSequenceLength: z.number().int().min(2).max(8192),
        maximumDurationSeconds: z.number().finite().min(1).max(21_600), maximumCheckpointBytes: z.number().int().positive().max(17_179_869_184)}).strict(),
    }).strict(),
  ]),
}).strict();
export const AlphaEditExecutionCapabilitySchema = AlphaEditExecutionCapabilityContentSchema.extend({contentHash: Hash});
export type AlphaEditExecutionCapability = z.infer<typeof AlphaEditExecutionCapabilitySchema>;

export const ManagedAlphaEditCompileSchema = z.object({teamId: Id, projectId: Id.nullable(), method: Method,
  query: Query, form: AlphaEditExperimentFormDraftSchema}).strict();
export type ManagedAlphaEditCompile = z.infer<typeof ManagedAlphaEditCompileSchema>;
export const ManagedAlphaEditCompilationContentSchema = z.object({
  schemaVersion: z.literal("openpond.managedAlphaEditCompilation.v1"), teamId: Id, actorId: Id,
  projectId: Id.nullable(), method: Method, query: Query, formHash: Hash, inputHash: Hash,
  request: AlphaEditTrainingRequestSchema,
}).strict();
export const ManagedAlphaEditCompilationSchema = ManagedAlphaEditCompilationContentSchema.extend({contentHash: Hash});
export type ManagedAlphaEditCompilation = z.infer<typeof ManagedAlphaEditCompilationSchema>;
export const ManagedAlphaEditPrepareSchema = z.object({teamId: Id, operationId: Id, projectId: Id.nullable(),
  name: z.string().trim().min(1).max(500), method: Method, query: Query,
  request: AlphaEditTrainingRequestSchema, maximumSpendUsd: Money.nullish(), sourceForm: AlphaEditExperimentFormDraftSchema.optional()}).strict();
export type ManagedAlphaEditPrepare = z.infer<typeof ManagedAlphaEditPrepareSchema>;
export const ManagedAlphaEditStartSchema = ManagedModificationStartSchema;
export const ManagedAlphaEditCancelSchema = ManagedModificationCancelSchema;
export type ManagedAlphaEditStart = z.infer<typeof ManagedAlphaEditStartSchema>;
export type ManagedAlphaEditCancel = z.infer<typeof ManagedAlphaEditCancelSchema>;
export const ManagedAlphaEditExecutionMetadataSchema = ManagedModificationExecutionMetadataSchema.omit({method: true}).extend({method: Method}).strict();
export const ManagedAlphaEditExecutionContentSchema = ManagedAlphaEditExecutionMetadataSchema.extend({
  schemaVersion: z.literal("openpond.managedAlphaEditExecution.v1"), request: AlphaEditTrainingRequestSchema,
  sourceForm: AlphaEditExperimentFormDraftSchema.optional(), result: AlphaEditTrainingResultSchema.nullable(),
  resultRecordedAt: z.iso.datetime().nullable(),
}).strict();
export const ManagedAlphaEditExecutionSchema = ManagedAlphaEditExecutionContentSchema.extend({contentHash: Hash});
export type ManagedAlphaEditExecution = z.infer<typeof ManagedAlphaEditExecutionSchema>;
export const ManagedAlphaEditExecutionReceiptContentSchema = z.object({
  schemaVersion: z.literal("openpond.managedAlphaEditExecutionReceipt.v1"), operationId: Id, requestHash: Hash,
  execution: ManagedAlphaEditExecutionMetadataSchema,
}).strict();
export const ManagedAlphaEditExecutionReceiptSchema = ManagedAlphaEditExecutionReceiptContentSchema.extend({contentHash: Hash});
export type ManagedAlphaEditExecutionReceipt = z.infer<typeof ManagedAlphaEditExecutionReceiptSchema>;
export const ManagedAlphaEditExecutionListQuerySchema = z.object({
  method: Method.default("alphaedit"), id: Id.optional(), projectId: Id.optional(),
  phase: ManagedAlphaEditExecutionMetadataSchema.shape.phase.optional(),
  limit: z.number().int().min(1).max(100).default(25), cursor: z.string().min(1).max(2048).optional(),
}).strict();
export type ManagedAlphaEditExecutionListQuery = z.input<typeof ManagedAlphaEditExecutionListQuerySchema>;
export const ManagedAlphaEditExecutionSummarySchema = ManagedAlphaEditExecutionMetadataSchema.extend({model: NeuronSteeringModelSchema}).strict();
export const ManagedAlphaEditExecutionPageContentSchema = z.object({
  schemaVersion: z.literal("openpond.managedAlphaEditExecutionPage.v1"), teamId: Id, ownerUserId: Id,
  query: ManagedAlphaEditExecutionListQuerySchema, items: z.array(ManagedAlphaEditExecutionSummarySchema).max(100),
  nextCursor: z.string().min(1).max(2048).nullable(),
}).strict();
export const ManagedAlphaEditExecutionPageSchema = ManagedAlphaEditExecutionPageContentSchema.extend({contentHash: Hash});
export type ManagedAlphaEditExecutionPage = z.infer<typeof ManagedAlphaEditExecutionPageSchema>;

export function parseAlphaEditFormTraining(raw: z.infer<typeof AlphaEditExperimentFormDraftSchema>["training"]) {
  const fields = Object.entries(raw).map(([key, value]) => {
    if (!value.trim()) throw new OpenPondProtocolError("alphaedit_training_settings_missing", "Complete each AlphaEdit training setting before preparing.");
    return [key, Number(value)] as const;
  });
  return AlphaEditTrainingSettingsSchema.parse(Object.fromEntries(fields));
}
function fail(): never {
  throw new OpenPondProtocolError("alphaedit_execution_mismatch", "The AlphaEdit operation differs from its exact model, data, settings or original approval.");
}
function checkSource(query: z.infer<typeof Query>, request: Pick<z.infer<typeof AlphaEditTrainingRequestSchema>, "model">) {
  if (query.source !== "managed" || query.modelAssetId !== undefined || !query.revision || !query.tokenizerRevision
    || query.modelId !== request.model.modelId || query.revision !== request.model.revision) fail();
}
export function parseAlphaEditFormConfig(form: z.infer<typeof AlphaEditExperimentFormDraftSchema>["config"]) {
  let contextTemplateGroups: unknown;
  try { contextTemplateGroups = JSON.parse(form.contextTemplateGroups); }
  catch { throw new OpenPondProtocolError("alphaedit_context_invalid", "Enter valid JSON context-template groups."); }
  if (!form.layers.trim() || form.layers.split(",").some(value => !/^\s*\d+\s*$/.test(value)))
    throw new OpenPondProtocolError("alphaedit_layers_invalid", "Enter comma-separated layer indexes.");
  if (![form.lossLayer, form.nullspaceThreshold, form.l2].every(value => value.trim()))
    throw new OpenPondProtocolError("alphaedit_config_missing", "Complete the AlphaEdit configuration.");
  return AlphaEditConfigSchema.parse({...ALPHAEDIT_CONFIG_DEFAULTS,
    layers: form.layers.split(",").map(Number), lossLayer: Number(form.lossLayer),
    contextTemplateGroups, nullspaceThreshold: Number(form.nullspaceThreshold), l2: Number(form.l2)});
}
async function checkForm(form: z.infer<typeof AlphaEditExperimentFormDraftSchema>, request: z.infer<typeof AlphaEditTrainingRequestSchema>) {
  if (!form.baseModel || form.baseModel.modelId !== request.model.modelId || form.baseModel.revision !== request.model.revision
    || canonicalJson(form.editsBatch) !== canonicalJson(request.data.edits.batch)
    || canonicalJson(form.preservationBatch) !== canonicalJson(request.data.preservation.batch)
    || canonicalJson(parseAlphaEditFormConfig(form.config)) !== canonicalJson(request.config)
    || canonicalJson(parseAlphaEditFormTraining(form.training)) !== canonicalJson(request.training)
    || canonicalJson(form.parentArtifact) !== canonicalJson(request.parentArtifact)) fail();
  if (form.startingModule && (canonicalJson(form.startingModule.artifact) !== canonicalJson(request.parentArtifact)
    || form.startingModule.modelHash !== await canonicalSha256(request.model))) fail();
}
function checkFormQuery(form: z.infer<typeof AlphaEditExperimentFormDraftSchema>, query: z.infer<typeof Query>) {
  const base = {schemaVersion: "openpond.baseModelPreference.v1", modelId: query.modelId, source: query.source,
    revision: query.revision ?? null, tokenizerRevision: query.tokenizerRevision ?? null,
    chatTemplateHash: query.chatTemplateHash ?? null, modelAssetId: query.modelAssetId ?? null};
  if (canonicalJson(form.baseModel) !== canonicalJson(base)) fail();
}
export async function parseAndVerifyAlphaEditExecutionCapability(raw: unknown, queryInput: z.infer<typeof Query>, actorId?: string) {
  const query = Query.parse(queryInput), value = AlphaEditExecutionCapabilitySchema.parse(raw), {contentHash, ...content} = value;
  assertModelModificationValidationLevel(value.execution, value.validationLevel);
  const checked = Date.parse(value.checkedAt), expires = Date.parse(value.expiresAt);
  if (value.teamId !== query.teamId || actorId !== undefined && value.actorId !== actorId
    || canonicalJson(value.query) !== canonicalJson(query) || value.requestHash !== await canonicalSha256(query)
    || contentHash !== await canonicalSha256(content) || checked > Date.now() + 30_000
    || expires <= Date.now() || expires <= checked || expires - checked > 300_000) fail();
  if (value.execution.state === "ready") checkSource(query, {model: value.execution.model});
  return value;
}
export async function parseAndVerifyManagedAlphaEditCompilation(raw: unknown, input: ManagedAlphaEditCompile) {
  const command = ManagedAlphaEditCompileSchema.parse(input), value = ManagedAlphaEditCompilationSchema.parse(raw), {contentHash, ...content} = value;
  const request = await parseAndVerifyAlphaEditTrainingRequest(value.request);
  checkSource(command.query, request); await checkForm(command.form, request); checkFormQuery(command.form, command.query);
  if (contentHash !== await canonicalSha256(content) || value.teamId !== command.teamId || command.query.teamId !== command.teamId
    || value.projectId !== command.projectId || canonicalJson(value.query) !== canonicalJson(command.query)
    || value.formHash !== await canonicalSha256(command.form) || value.inputHash !== await canonicalSha256(request)) fail();
  return value;
}
export async function parseAndVerifyManagedAlphaEditExecution(raw: unknown, expected: {teamId: string; id: string; ownerUserId?: string}) {
  const value = ManagedAlphaEditExecutionSchema.parse(raw), {contentHash, ...content} = value;
  const request = await parseAndVerifyAlphaEditTrainingRequest(value.request);
  if (contentHash !== await canonicalSha256(content) || value.teamId !== expected.teamId || value.id !== expected.id
    || expected.ownerUserId !== undefined && value.ownerUserId !== expected.ownerUserId
    || value.plan.inputHash !== await canonicalSha256(request)
    || value.result === null && value.resultRecordedAt !== null || value.result !== null && value.resultRecordedAt === null) fail();
  if (value.sourceForm) await checkForm(value.sourceForm, request);
  if (value.result) await parseAndVerifyAlphaEditTrainingResult(value.result, {request, runtimeHash: value.plan.runtimeHash});
  return value;
}
export async function parseAndVerifyManagedAlphaEditPrepare(raw: unknown) {
  const request = ManagedAlphaEditPrepareSchema.parse(raw);
  request.maximumSpendUsd = canonicalComputeSpendCap(request.maximumSpendUsd);
  await parseAndVerifyAlphaEditTrainingRequest(request.request);
  checkSource(request.query, request.request);
  if (request.query.teamId !== request.teamId) fail();
  if (request.sourceForm) {
    await checkForm(request.sourceForm, request.request); checkFormQuery(request.sourceForm, request.query);
    if (canonicalComputeSpendCap(request.sourceForm.maximumSpendUsd) !== request.maximumSpendUsd) fail();
  }
  return request;
}
export async function parseAndVerifyManagedAlphaEditExecutionReceipt(raw: unknown, command: ManagedAlphaEditPrepare | ManagedAlphaEditStart | ManagedAlphaEditCancel) {
  const request = "action" in command ? parseManagedModificationControl(command) : await parseAndVerifyManagedAlphaEditPrepare(command);
  const value = ManagedAlphaEditExecutionReceiptSchema.parse(raw), {contentHash, ...content} = value;
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
    await parseAndVerifyAlphaEditTrainingRequest(request.request); checkSource(request.query, request.request);
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
function parseExecutionListQuery(raw: ManagedAlphaEditExecutionListQuery = {}) {
  const query = ManagedAlphaEditExecutionListQuerySchema.parse(raw);
  return ManagedAlphaEditExecutionListQuerySchema.parse(Object.fromEntries(
    Object.entries(query).filter(([, value]) => value !== undefined),
  ));
}

export async function parseAndVerifyManagedAlphaEditExecutionPage(raw: unknown, expected: {
  teamId: string; ownerUserId?: string; query?: ManagedAlphaEditExecutionListQuery;
}) {
  const value = ManagedAlphaEditExecutionPageSchema.parse(raw), {contentHash, ...content} = value;
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
 * AlphaEdit parsing never coerces a module into an activation or LoRA result. */
export function createManagedAlphaEditExecutionClient(request: (path: string, init?: RequestInit) => Promise<unknown>) {
  const root = "/v1/training/modification-executions";
  return {
    async alphaEditExecutionCapability(raw: z.infer<typeof Query>, options?: {signal?: AbortSignal}) {
      const query = Query.parse(raw);
      return parseAndVerifyAlphaEditExecutionCapability(await request(`/v1/training/modification-capabilities/alphaedit?${params(query)}`, options), query);
    },
    async compileAlphaEditExecution(raw: ManagedAlphaEditCompile) {
      const command = ManagedAlphaEditCompileSchema.parse(raw);
      return parseAndVerifyManagedAlphaEditCompilation(await request(`${root}/compile`, {method: "POST", body: canonicalJson(command)}), command);
    },
    async prepareAlphaEditExecution(raw: ManagedAlphaEditPrepare) {
      const command = await parseAndVerifyManagedAlphaEditPrepare(raw);
      return parseAndVerifyManagedAlphaEditExecutionReceipt(await request(`${root}/prepare`, {method: "POST", body: canonicalJson(command)}), command);
    },
    async startAlphaEditExecution(raw: ManagedAlphaEditStart) {
      const command = parseManagedModificationControl(ManagedAlphaEditStartSchema.parse(raw));
      return parseAndVerifyManagedAlphaEditExecutionReceipt(await request(`${root}/${encodeURIComponent(command.id)}/start`, {method: "POST", body: canonicalJson(command)}), command);
    },
    async cancelAlphaEditExecution(raw: ManagedAlphaEditCancel) {
      const command = ManagedAlphaEditCancelSchema.parse(raw);
      return parseAndVerifyManagedAlphaEditExecutionReceipt(await request(`${root}/${encodeURIComponent(command.id)}/cancel`, {method: "POST", body: canonicalJson(command)}), command);
    },
    async getAlphaEditExecution(teamId: string, id: string, options?: {signal?: AbortSignal; ownerUserId?: string}) {
      const scope = {teamId: Id.parse(teamId), id: Id.parse(id), ownerUserId: options?.ownerUserId};
      return parseAndVerifyManagedAlphaEditExecution(await request(`${root}/${encodeURIComponent(scope.id)}?${params({teamId: scope.teamId})}`, {signal: options?.signal}), scope);
    },
    async listAlphaEditExecutions(teamId: string, raw: ManagedAlphaEditExecutionListQuery = {}, options?: {signal?: AbortSignal; ownerUserId?: string}) {
      const team = Id.parse(teamId), query = parseExecutionListQuery(raw);
      return parseAndVerifyManagedAlphaEditExecutionPage(await request(`${root}?${params({teamId: team, ...query})}`, {signal: options?.signal}), {teamId: team, query, ownerUserId: options?.ownerUserId});
    },
  };
}
