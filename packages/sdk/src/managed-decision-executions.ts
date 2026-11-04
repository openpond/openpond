import { canonicalComputeSpendCap, managedModificationPriceApprovalMatches } from "./managed-compute-price.js";
import { z } from "zod";
import { assertBoundedTaskJson } from "@openpond/evals/task-schema";
import { canonicalJson, canonicalJsonByteLength, canonicalSha256, OpenPondProtocolError, parseBoundedJson } from "./protocol.js";
import { ModelModificationCapabilitiesQuerySchema, ModelModificationValidationLevelSchema, assertModelModificationValidationLevel } from "./model-modification-capabilities.js";
import { ManagedModificationExecutionMetadataSchema, ManagedModificationStartSchema, ManagedModificationCancelSchema,
   parseManagedModificationControl } from "./managed-modification-executions.js";
import { DecisionModelIdentitySchema, parseAndVerifyDecisionModelIdentity } from "./decision-model.js";
import { DecisionTrainingRequestSchema, DecisionTrainingResultSchema, DecisionTrainingSettingsSchema,
  parseAndVerifyDecisionTrainingRequest, parseAndVerifyDecisionTrainingResult } from "./decision-model-training.js";
import { DecisionScoringInputSchema, DecisionScoringRequestSchema, DecisionScoringResultSchema,
  parseAndVerifyDecisionScoringRequest, parseAndVerifyDecisionScoringResult } from "./decision-model-data.js";
import { DecisionExperimentFormDraftSchema, DecisionTrainingFormDraftSchema, type DecisionExperimentFormDraft } from "./decision-experiment-draft.js";

const Id = z.string().trim().min(1).max(240), Hash = z.string().regex(/^[a-f0-9]{64}$/);
const Money = z.string().regex(/^(0|[1-9]\d*)(\.\d{1,6})?$/).max(48);
const Method = z.literal("decision_model"), Mode = z.enum(["train", "score"]);
const Query = ModelModificationCapabilitiesQuerySchema;
export const DecisionExecutionRequestSchema = z.discriminatedUnion("schemaVersion", [DecisionTrainingRequestSchema, DecisionScoringRequestSchema]);
export type DecisionExecutionRequest = z.infer<typeof DecisionExecutionRequestSchema>;
export const DecisionExecutionResultSchema = z.discriminatedUnion("schemaVersion", [DecisionTrainingResultSchema, DecisionScoringResultSchema]);
export type DecisionExecutionResult = z.infer<typeof DecisionExecutionResultSchema>;
export const DecisionExecutionCapabilityContentSchema = z.object({
  schemaVersion: z.literal("openpond.decisionExecutionCapability.v1"),
  teamId: Id, actorId: Id, query: Query, requestHash: Hash,
  checkedAt: z.iso.datetime(), expiresAt: z.iso.datetime(),
  validationLevel: ModelModificationValidationLevelSchema.nullable(),
  execution: z.discriminatedUnion("state", [
    z.object({ state: z.literal("unavailable"), code: z.enum(["model_not_supported", "runtime_not_qualified"]), reason: z.string().min(1).max(1000) }).strict(),
    z.object({ state: z.literal("ready"), model: DecisionModelIdentitySchema,
      runtime: z.object({ id: Id, releaseHash: Hash, imageDigest: z.string().regex(/^sha256:[a-f0-9]{64}$/),
        requestSchemas: z.tuple([z.literal("openpond.decisionTrainingRequest.v1"), z.literal("openpond.decisionScoringRequest.v1")]),
        evidence: z.object({ id: Id, contentHash: Hash }).strict(),
      }).strict(),
      limits: z.object({
        train: z.object({
          maximumExamples: z.number().int().min(1).max(4096), maximumDataBytes: z.number().int().positive().max(8_388_608),
          maximumSteps: z.number().int().min(1).max(4096), maximumGradientAccumulationSteps: z.number().int().min(1).max(64),
          maximumPromptTokens: z.number().int().min(1).max(2048), maximumForwardTokenWork: z.number().int().positive().max(536_870_912),
          maximumDurationSeconds: z.number().finite().min(1).max(21_600), maximumCheckpointBytes: z.number().int().positive().max(268_435_456),
        }).strict(),
        score: z.object({
          maximumQuestions: z.number().int().min(1).max(8), maximumChoicesPerQuestion: z.number().int().min(2).max(26),
          maximumStateBytes: z.number().int().positive().max(65_536), maximumPromptTokens: z.number().int().min(1).max(2048),
          maximumForwardTokenWork: z.number().int().positive().max(65_536), maximumDurationSeconds: z.number().finite().positive().max(300),
        }).strict(),
      }).strict(),
    }).strict(),
  ]),
}).strict();
export const DecisionExecutionCapabilitySchema = DecisionExecutionCapabilityContentSchema.extend({ contentHash: Hash });
export type DecisionExecutionCapability = z.infer<typeof DecisionExecutionCapabilitySchema>;

export const ManagedDecisionCompileSchema = z.object({ teamId: Id, projectId: Id.nullable(), method: Method,
  mode: Mode, query: Query, form: DecisionExperimentFormDraftSchema }).strict();
export type ManagedDecisionCompile = z.infer<typeof ManagedDecisionCompileSchema>;
export const ManagedDecisionCompilationContentSchema = z.object({
  schemaVersion: z.literal("openpond.managedDecisionCompilation.v1"), teamId: Id, actorId: Id,
  projectId: Id.nullable(), method: Method, mode: Mode, query: Query, formHash: Hash, inputHash: Hash,
  request: DecisionExecutionRequestSchema,
}).strict();
export const ManagedDecisionCompilationSchema = ManagedDecisionCompilationContentSchema.extend({ contentHash: Hash });
export type ManagedDecisionCompilation = z.infer<typeof ManagedDecisionCompilationSchema>;
export const ManagedDecisionPrepareSchema = z.object({ teamId: Id, operationId: Id, projectId: Id.nullable(),
  name: z.string().trim().min(1).max(500), method: Method, mode: Mode, query: Query,
  request: DecisionExecutionRequestSchema, maximumSpendUsd: Money.nullish(), sourceForm: DecisionExperimentFormDraftSchema.optional(),
}).strict();
export type ManagedDecisionPrepare = z.infer<typeof ManagedDecisionPrepareSchema>;
export const ManagedDecisionStartSchema = ManagedModificationStartSchema;
export const ManagedDecisionCancelSchema = ManagedModificationCancelSchema;
export type ManagedDecisionStart = z.infer<typeof ManagedDecisionStartSchema>;
export type ManagedDecisionCancel = z.infer<typeof ManagedDecisionCancelSchema>;
export const ManagedDecisionExecutionMetadataSchema = ManagedModificationExecutionMetadataSchema.omit({ method: true }).extend({ method: Method, mode: Mode }).strict();
export type ManagedDecisionExecutionMetadata = z.infer<typeof ManagedDecisionExecutionMetadataSchema>;
export const ManagedDecisionExecutionContentSchema = ManagedDecisionExecutionMetadataSchema.extend({
  schemaVersion: z.literal("openpond.managedDecisionExecution.v1"), request: DecisionExecutionRequestSchema,
  sourceForm: DecisionExperimentFormDraftSchema.optional(), result: DecisionExecutionResultSchema.nullable(), resultRecordedAt: z.iso.datetime().nullable(),
}).strict();
export const ManagedDecisionExecutionSchema = ManagedDecisionExecutionContentSchema.extend({ contentHash: Hash });
export type ManagedDecisionExecution = z.infer<typeof ManagedDecisionExecutionSchema>;
export const ManagedDecisionExecutionReceiptContentSchema = z.object({
  schemaVersion: z.literal("openpond.managedDecisionExecutionReceipt.v1"), operationId: Id, requestHash: Hash,
  execution: ManagedDecisionExecutionMetadataSchema,
}).strict();
export const ManagedDecisionExecutionReceiptSchema = ManagedDecisionExecutionReceiptContentSchema.extend({ contentHash: Hash });
export type ManagedDecisionExecutionReceipt = z.infer<typeof ManagedDecisionExecutionReceiptSchema>;
export const ManagedDecisionExecutionListQuerySchema = z.object({
  method: Method.default("decision_model"), mode: Mode.optional(), id: Id.optional(), projectId: Id.optional(),
  phase: ManagedDecisionExecutionMetadataSchema.shape.phase.optional(),
  limit: z.number().int().min(1).max(100).default(25), cursor: z.string().min(1).max(2048).optional(),
}).strict();
export type ManagedDecisionExecutionListQuery = z.input<typeof ManagedDecisionExecutionListQuerySchema>;
export const ManagedDecisionExecutionSummarySchema = ManagedDecisionExecutionMetadataSchema.extend({ model: DecisionModelIdentitySchema }).strict();
export type ManagedDecisionExecutionSummary = z.infer<typeof ManagedDecisionExecutionSummarySchema>;
export const ManagedDecisionExecutionPageContentSchema = z.object({
  schemaVersion: z.literal("openpond.managedDecisionExecutionPage.v1"), teamId: Id, ownerUserId: Id,
  query: ManagedDecisionExecutionListQuerySchema, items: z.array(ManagedDecisionExecutionSummarySchema).max(100),
  nextCursor: z.string().min(1).max(2048).nullable(),
}).strict();
export const ManagedDecisionExecutionPageSchema = ManagedDecisionExecutionPageContentSchema.extend({ contentHash: Hash });
export type ManagedDecisionExecutionPage = z.infer<typeof ManagedDecisionExecutionPageSchema>;

function fail(): never {
  throw new OpenPondProtocolError("decision_execution_mismatch", "The decision operation differs from its exact source, mode, input, settings or original approval.");
}
function requestMode(request: DecisionExecutionRequest) {
  return request.schemaVersion === "openpond.decisionTrainingRequest.v1" ? "train" : "score";
}
function querySource(query: z.infer<typeof Query>) {
  return { schemaVersion: "openpond.baseModelPreference.v1", modelId: query.modelId, source: query.source,
    revision: query.revision ?? null, tokenizerRevision: query.tokenizerRevision ?? null,
    chatTemplateHash: query.chatTemplateHash ?? null, modelAssetId: query.modelAssetId ?? null };
}
function checkSource(query: z.infer<typeof Query>, model: z.infer<typeof DecisionModelIdentitySchema>) {
  if (canonicalJson(querySource(query)) !== canonicalJson(model.source)) fail();
}
function formNumbers(raw: Record<string, string>) {
  return Object.fromEntries(Object.entries(raw).map(([key, value]) => {
    if (!value.trim()) throw new OpenPondProtocolError("decision_settings_missing", "Complete each decision setting before compiling.");
    return [key, Number(value)];
  }));
}
export function parseDecisionFormTraining(raw: z.infer<typeof DecisionTrainingFormDraftSchema>) {
  return DecisionTrainingSettingsSchema.parse(formNumbers(raw));
}
/** Compiles raw unlabeled authoring only; the host still resolves the actual
 * released tokenizer and must enforce answer-boundary tokens and prompt work. */
export function parseDecisionFormScoring(raw: z.infer<typeof DecisionExperimentFormDraftSchema> & { mode: "score" }) {
  const input = DecisionScoringInputSchema.parse({
    state: parseBoundedJson(raw.stateJson, 131_072, "Decision state"),
    questions: raw.questions.map(row => ({ ...row, choices: row.choices.map(choice => {
      let value: string | boolean | number = choice.value;
      if (row.type === "boolean") {
        if (value !== "false" && value !== "true") fail();
        value = value === "true";
      } else if (row.type === "integer_levels") {
        if (!/^-?(0|[1-9]\d*)$/.test(value)) fail();
        value = Number(value);
      }
      return { value, description: choice.description };
    }) })),
  });
  return { input, limits: DecisionScoringRequestSchema.shape.limits.parse(formNumbers(raw.limits)) };
}
async function checkForm(form: DecisionExperimentFormDraft, request: DecisionExecutionRequest) {
  const parent = request.schemaVersion === "openpond.decisionTrainingRequest.v1" ? request.parentArtifact : request.artifact;
  if (form.mode !== requestMode(request) || canonicalJson(form.baseModel) !== canonicalJson(request.model.source)
    || canonicalJson(form.parentArtifact) !== canonicalJson(parent)) fail();
  if (form.startingDecision && (canonicalJson(form.startingDecision.artifact) !== canonicalJson(parent)
    || form.startingDecision.modelHash !== await canonicalSha256(request.model))) fail();
  if (form.mode === "train" && request.schemaVersion === "openpond.decisionTrainingRequest.v1") {
    if (canonicalJson(form.batch) !== canonicalJson(request.data.batch)
      || canonicalJson(parseDecisionFormTraining(form.training)) !== canonicalJson(request.training)) fail();
  } else if (form.mode === "score" && request.schemaVersion === "openpond.decisionScoringRequest.v1") {
    const parsed = parseDecisionFormScoring(form);
    if (canonicalJson(parsed.input) !== canonicalJson(request.input) || canonicalJson(parsed.limits) !== canonicalJson(request.limits)) fail();
  } else fail();
}
async function verifyRequest(raw: unknown) {
  const request = DecisionExecutionRequestSchema.parse(raw);
  return request.schemaVersion === "openpond.decisionTrainingRequest.v1"
    ? parseAndVerifyDecisionTrainingRequest(request) : parseAndVerifyDecisionScoringRequest(request);
}
function checkPlan(metadata: ManagedDecisionExecutionMetadata) {
  if (metadata.plan.maximumSpendUsd !== canonicalComputeSpendCap(metadata.plan.maximumSpendUsd)
    || Date.parse(metadata.plan.expiresAt) <= Date.parse(metadata.plan.createdAt)) fail();
}

/** An observation, not a reservation, worker claim or approval. A host must
 * distinguish source-validated staging trials from exact GPU qualification. */
export async function parseAndVerifyDecisionExecutionCapability(raw: unknown, input: z.infer<typeof Query>, actorId?: string) {
  const query = Query.parse(input), value = DecisionExecutionCapabilitySchema.parse(raw), { contentHash, ...content } = value;
  assertModelModificationValidationLevel(value.execution, value.validationLevel);
  const checked = Date.parse(value.checkedAt), expiry = Date.parse(value.expiresAt);
  if (value.teamId !== query.teamId || actorId !== undefined && value.actorId !== actorId
    || canonicalJson(value.query) !== canonicalJson(query) || value.requestHash !== await canonicalSha256(query)
    || contentHash !== await canonicalSha256(content) || checked > Date.now() + 30_000
    || expiry <= Date.now() || expiry <= checked || expiry - checked > 300_000) fail();
  if (value.execution.state === "ready") {
    await parseAndVerifyDecisionModelIdentity(value.execution.model); checkSource(query, value.execution.model);
  }
  return value;
}
/** Fresh capability bounds only. The hosted reviewed-data owner must also
 * check actual training example count/byte size; a batch ref cannot prove them. */
export async function verifyDecisionExecutionCapabilityRequest(raw: DecisionExecutionCapability, input: DecisionExecutionRequest) {
  const capability = await parseAndVerifyDecisionExecutionCapability(raw, raw.query, raw.actorId);
  const request = await verifyRequest(input), execution = capability.execution;
  if (execution.state !== "ready")
    throw new OpenPondProtocolError("decision_runtime_unavailable", "This exact decision runtime is not qualified for execution.");
  if (canonicalJson(execution.model) !== canonicalJson(request.model)) fail();
  if (request.schemaVersion === "openpond.decisionTrainingRequest.v1") {
    const limits = execution.limits.train, settings = request.training;
    if (settings.maxSteps > limits.maximumSteps || settings.gradientAccumulationSteps > limits.maximumGradientAccumulationSteps
      || settings.maximumPromptTokens > limits.maximumPromptTokens || settings.maxDurationSeconds > limits.maximumDurationSeconds
      || settings.maxCheckpointBytes > limits.maximumCheckpointBytes
      || settings.maxSteps * settings.gradientAccumulationSteps * settings.maximumPromptTokens > limits.maximumForwardTokenWork) fail();
  } else {
    const limits = execution.limits.score;
    if (request.input.questions.length > limits.maximumQuestions
      || request.input.questions.some(question => question.choices.length > limits.maximumChoicesPerQuestion)
      || canonicalJsonByteLength(request.input.state) > limits.maximumStateBytes
      || request.limits.maximumPromptTokens > limits.maximumPromptTokens
      || request.limits.maximumForwardTokenWork > limits.maximumForwardTokenWork
      || request.limits.maximumDurationSeconds > limits.maximumDurationSeconds) fail();
  }
  return execution;
}
export function parseManagedDecisionCompile(raw: unknown) {
  assertBoundedTaskJson(raw, 1_048_576);
  const value = ManagedDecisionCompileSchema.parse(raw);
  if (value.query.teamId !== value.teamId || value.mode !== value.form.mode
    || canonicalJson(value.form.baseModel) !== canonicalJson(querySource(value.query))) fail();
  if (!value.form.name.trim()) fail();
  canonicalComputeSpendCap(value.form.maximumSpendUsd);
  if (value.form.mode === "train") {
    if (value.form.batch === null) fail();
    parseDecisionFormTraining(value.form.training);
  } else parseDecisionFormScoring(value.form);
  return value;
}
export async function parseAndVerifyManagedDecisionCompilation(raw: unknown, input: ManagedDecisionCompile, actorId?: string) {
  const command = parseManagedDecisionCompile(input), value = ManagedDecisionCompilationSchema.parse(raw), { contentHash, ...content } = value;
  const request = await verifyRequest(value.request);
  checkSource(command.query, request.model); await checkForm(command.form, request);
  if (contentHash !== await canonicalSha256(content) || value.teamId !== command.teamId || value.projectId !== command.projectId
    || actorId !== undefined && value.actorId !== actorId || value.mode !== command.mode || value.mode !== requestMode(request)
    || canonicalJson(value.query) !== canonicalJson(command.query)
    || value.formHash !== await canonicalSha256(command.form) || value.inputHash !== await canonicalSha256(request)) fail();
  return value;
}
/** A source form is optional for direct typed callers. When present, the host
 * must freshly resolve its reviewed batch/saved source and recompile it before
 * admitting a new preparation; public verification cannot establish Dataset
 * authorization from a caller-supplied examples digest. Original receipt replay
 * must precede those fresh mutable authorization/qualification checks. */
export async function parseAndVerifyManagedDecisionPrepare(raw: unknown) {
  assertBoundedTaskJson(raw, 1_048_576);
  const command = ManagedDecisionPrepareSchema.parse(raw);
  command.maximumSpendUsd = canonicalComputeSpendCap(command.maximumSpendUsd);
  const request = await verifyRequest(command.request);
  if (command.query.teamId !== command.teamId || command.mode !== requestMode(request)) fail();
  checkSource(command.query, request.model);
  if (command.sourceForm) {
    await checkForm(command.sourceForm, request);
    if (command.sourceForm.name.trim() !== command.name
      || canonicalComputeSpendCap(command.sourceForm.maximumSpendUsd) !== command.maximumSpendUsd) fail();
  }
  return command;
}
export async function parseAndVerifyManagedDecisionExecution(raw: unknown, expected: { teamId: string; id: string; ownerUserId?: string }) {
  assertBoundedTaskJson(raw, 1_048_576);
  const value = ManagedDecisionExecutionSchema.parse(raw), { contentHash, ...content } = value;
  const request = await verifyRequest(value.request); checkPlan(value);
  if (contentHash !== await canonicalSha256(content) || value.teamId !== expected.teamId || value.id !== expected.id
    || expected.ownerUserId !== undefined && value.ownerUserId !== expected.ownerUserId || value.mode !== requestMode(request)
    || value.plan.inputHash !== await canonicalSha256(request)
    || value.result === null && value.resultRecordedAt !== null || value.result !== null && value.resultRecordedAt === null
    || value.phase === "completed" && value.result === null) fail();
  if (value.sourceForm) {
    await checkForm(value.sourceForm, request);
    if (value.sourceForm.name.trim() !== value.name
      || canonicalComputeSpendCap(value.sourceForm.maximumSpendUsd) !== value.plan.maximumSpendUsd) fail();
  }
  if (value.result) {
    if (request.schemaVersion === "openpond.decisionTrainingRequest.v1" && value.result.schemaVersion === "openpond.decisionTrainingResult.v1")
      await parseAndVerifyDecisionTrainingResult(value.result, { request, runtimeHash: value.plan.runtimeHash });
    else if (request.schemaVersion === "openpond.decisionScoringRequest.v1" && value.result.schemaVersion === "openpond.decisionScoringResult.v1")
      await parseAndVerifyDecisionScoringResult(value.result, { request, runtimeHash: value.plan.runtimeHash });
    else fail();
  }
  return value;
}
export async function parseAndVerifyManagedDecisionExecutionReceipt(raw: unknown, input: ManagedDecisionPrepare | ManagedDecisionStart | ManagedDecisionCancel, ownerUserId?: string) {
  const command = "action" in input ? parseManagedModificationControl(input) : await parseAndVerifyManagedDecisionPrepare(input);
  const value = ManagedDecisionExecutionReceiptSchema.parse(raw), { contentHash, ...content } = value;
  const metadata = value.execution; checkPlan(metadata);
  if (contentHash !== await canonicalSha256(content) || value.operationId !== command.operationId || metadata.teamId !== command.teamId
    || ownerUserId !== undefined && metadata.ownerUserId !== ownerUserId
    || value.requestHash !== await canonicalSha256("action" in command ? command : { action: "prepare", command })) fail();
  if ("action" in command) {
    if (metadata.id !== command.id || metadata.plan.contentHash !== command.planHash || metadata.revision !== command.expectedRevision + 1
      || (command.action === "start" ? metadata.phase !== "queued" || metadata.plan.maximumSpendUsd !== command.approvedMaximumSpendUsd || !await managedModificationPriceApprovalMatches(metadata.plan,command)
        : !["cancelled", "stopping"].includes(metadata.phase))) fail();
  } else if (metadata.projectId !== command.projectId || metadata.name !== command.name || metadata.mode !== command.mode
    || metadata.plan.inputHash !== await canonicalSha256(command.request) || metadata.plan.maximumSpendUsd !== command.maximumSpendUsd
    || metadata.phase !== "prepared" || metadata.revision !== 1
    || metadata.id !== `modification-${await canonicalSha256({ teamId: command.teamId, ownerUserId: metadata.ownerUserId, operationId: command.operationId })}`) fail();
  return value;
}
/** Optional undefined properties are omission at the query boundary. Keep
 * canonical JSON strict, and retain schema defaults/validation for all values. */
function parseExecutionListQuery(raw: ManagedDecisionExecutionListQuery = {}) {
  const query = ManagedDecisionExecutionListQuerySchema.parse(raw);
  return ManagedDecisionExecutionListQuerySchema.parse(Object.fromEntries(
    Object.entries(query).filter(([, value]) => value !== undefined),
  ));
}

export async function parseAndVerifyManagedDecisionExecutionPage(raw: unknown, expected: { teamId: string; ownerUserId?: string; query?: ManagedDecisionExecutionListQuery }) {
  const value = ManagedDecisionExecutionPageSchema.parse(raw), { contentHash, ...content } = value;
  const query = parseExecutionListQuery(expected.query);
  if (contentHash !== await canonicalSha256(content) || value.teamId !== expected.teamId
    || expected.ownerUserId !== undefined && value.ownerUserId !== expected.ownerUserId || canonicalJson(value.query) !== canonicalJson(query)
    || value.items.length > query.limit || new Set(value.items.map(item => item.id)).size !== value.items.length
    || value.nextCursor !== null && (value.items.length !== query.limit || value.nextCursor === query.cursor)) fail();
  for (const [index, item] of value.items.entries()) {
    const previous = value.items[index - 1];
    checkPlan(item); await parseAndVerifyDecisionModelIdentity(item.model);
    if (item.teamId !== value.teamId || item.ownerUserId !== value.ownerUserId || query.mode !== undefined && item.mode !== query.mode
      || query.id !== undefined && item.id !== query.id || query.projectId !== undefined && item.projectId !== query.projectId
      || query.phase !== undefined && item.phase !== query.phase
      || previous && (Date.parse(previous.plan.createdAt) < Date.parse(item.plan.createdAt)
        || Date.parse(previous.plan.createdAt) === Date.parse(item.plan.createdAt) && previous.id <= item.id)) fail();
  }
  return value;
}

function params(value: Record<string, unknown>) {
  const result = new URLSearchParams();
  for (const [key, item] of Object.entries(value)) if (item !== undefined) result.set(key, String(item));
  return result;
}
type Options = { signal?: AbortSignal; ownerUserId?: string };
/** Uses the configured canonical transport and existing modification owner.
 * Neither typed branch passes through activation/Engram request parsers. */
export function createManagedDecisionExecutionClient(request: (path: string, init?: RequestInit) => Promise<unknown>) {
  const root = "/v1/training/modification-executions";
  return {
    async decisionExecutionCapability(raw: z.infer<typeof Query>, options?: Options) {
      const query = Query.parse(raw);
      return parseAndVerifyDecisionExecutionCapability(await request(`/v1/training/modification-capabilities/decision?${params(query)}`, { signal: options?.signal }), query, options?.ownerUserId);
    },
    async compileDecisionExecution(raw: ManagedDecisionCompile, options?: Options) {
      const command = parseManagedDecisionCompile(raw);
      return parseAndVerifyManagedDecisionCompilation(await request(`${root}/compile`, { method: "POST", body: canonicalJson(command), signal: options?.signal }), command, options?.ownerUserId);
    },
    async prepareDecisionExecution(raw: ManagedDecisionPrepare, options?: Options) {
      const command = await parseAndVerifyManagedDecisionPrepare(raw);
      return parseAndVerifyManagedDecisionExecutionReceipt(await request(`${root}/prepare`, { method: "POST", body: canonicalJson(command), signal: options?.signal }), command, options?.ownerUserId);
    },
    async startDecisionExecution(raw: ManagedDecisionStart, options?: Options) {
      const command = parseManagedModificationControl(ManagedDecisionStartSchema.parse(raw));
      return parseAndVerifyManagedDecisionExecutionReceipt(await request(`${root}/${encodeURIComponent(command.id)}/start`, { method: "POST", body: canonicalJson(command), signal: options?.signal }), command, options?.ownerUserId);
    },
    async cancelDecisionExecution(raw: ManagedDecisionCancel, options?: Options) {
      const command = parseManagedModificationControl(ManagedDecisionCancelSchema.parse(raw));
      return parseAndVerifyManagedDecisionExecutionReceipt(await request(`${root}/${encodeURIComponent(command.id)}/cancel`, { method: "POST", body: canonicalJson(command), signal: options?.signal }), command, options?.ownerUserId);
    },
    async getDecisionExecution(teamId: string, id: string, options?: Options) {
      const scope = { teamId: Id.parse(teamId), id: Id.parse(id), ownerUserId: options?.ownerUserId };
      return parseAndVerifyManagedDecisionExecution(await request(`${root}/${encodeURIComponent(scope.id)}?${params({ teamId: scope.teamId })}`, { signal: options?.signal }), scope);
    },
    async listDecisionExecutions(teamId: string, raw: ManagedDecisionExecutionListQuery = {}, options?: Options) {
      const team = Id.parse(teamId), query = parseExecutionListQuery(raw);
      return parseAndVerifyManagedDecisionExecutionPage(await request(`${root}?${params({ teamId: team, ...query })}`, { signal: options?.signal }), { teamId: team, query, ownerUserId: options?.ownerUserId });
    },
  };
}
