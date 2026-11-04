import { ManagedModificationPriceSchema, canonicalComputeSpendCap, assertManagedModificationPricing, managedModificationPriceApprovalMatches } from "./managed-compute-price.js";
import { activationStartingProfileSource } from "./steering-experiment-source.js";
import { z } from "zod";
import { canonicalJson, canonicalSha256, OpenPondProtocolError } from "./protocol.js";
import {
  ActivationReferenceRequestSchema,
  ActivationReferenceResultSchema,
  parseAndVerifyActivationReferenceRequest,
  parseAndVerifyActivationReferenceResult,
} from "./activation-reference.js";
import { ModelModificationCapabilitiesQuerySchema, ModelModificationMethodSchema } from "./model-modification-capabilities.js";
import { parseManagedModificationCompile, parseAndVerifyManagedModificationCompilation, type ManagedModificationCompile } from "./managed-modification-compilation.js";
import { ActivationExperimentFormDraftSchema } from "./activation-experiment-draft.js";
export * from "./managed-modification-compilation.js";

const Id = z.string().trim().min(1).max(240);
const Hash = z.string().regex(/^[a-f0-9]{64}$/);

/** Customer read projection. Capture availability is independent of execution
 * cleanup and funding settlement; this read grants no dispatch authority. */
export const ManagedModificationExecutionContentSchema = z.object({
  schemaVersion: z.literal("openpond.managedModificationExecution.v1"),
  id: Id,
  teamId: Id,
  ownerUserId: Id,
  projectId: Id.nullable(),
  name: z.string().trim().min(1).max(500),
  method: ModelModificationMethodSchema,
  phase: z.enum(["prepared", "queued", "dispatching", "stopping", "cancelled", "completed", "failed"]),
  revision: z.number().int().positive(),
  sourceContentHash: Hash,
  plan: z.object({
    contentHash: Hash,
    inputHash: Hash,
    runtimeHash: Hash,
    maximumSpendUsd: z.string().regex(/^(0|[1-9]\d*)(\.\d{1,6})?$/).max(48).nullable(),
    computePrice: ManagedModificationPriceSchema.optional(),
    createdAt: z.iso.datetime(),
    expiresAt: z.iso.datetime(),
  }).strict().superRefine((plan,ctx)=>{
    try { assertManagedModificationPricing(plan); }
    catch { ctx.addIssue({code:"custom",message:"Retain the accepted rate, runtime and optional spending limit."}); }
  }),
  request: ActivationReferenceRequestSchema,
  sourceForm: ActivationExperimentFormDraftSchema.optional(),
  result: ActivationReferenceResultSchema.nullable(),
  resultRecordedAt: z.iso.datetime().nullable(),
  updatedAt: z.iso.datetime(),
}).strict();
export const ManagedModificationExecutionSchema = ManagedModificationExecutionContentSchema.extend({ contentHash: Hash }).strict();
export type ManagedModificationExecution = z.infer<typeof ManagedModificationExecutionSchema>;

const Spend = z.string().regex(/^(0|[1-9]\d*)(\.\d{1,6})?$/).max(48);
/** Requested inputs only. Runtime selection and paid admission belong to the host. */
export const ManagedModificationPrepareSchema = z.object({
  teamId: Id, operationId: Id, projectId: Id.nullable(), name: z.string().trim().min(1).max(500),
  method: ModelModificationMethodSchema, query: ModelModificationCapabilitiesQuerySchema,
  request: ActivationReferenceRequestSchema, maximumSpendUsd: Spend.nullish(),
  sourceForm: ActivationExperimentFormDraftSchema.optional(),
}).strict();
const control = {teamId: Id, id: Id, operationId: Id, expectedRevision: z.number().int().positive(), planHash: Hash};
export const ManagedModificationStartSchema = z.object({...control, action: z.literal("start"), approvedMaximumSpendUsd: Spend.nullable(), approvedPriceHash: Hash.optional()}).strict();
export const ManagedModificationCancelSchema = z.object({...control, action: z.literal("cancel")}).strict();
export type ManagedModificationPrepare = z.infer<typeof ManagedModificationPrepareSchema>;
export type ManagedModificationStart = z.infer<typeof ManagedModificationStartSchema>;
export type ManagedModificationCancel = z.infer<typeof ManagedModificationCancelSchema>;
export const ManagedModificationExecutionMetadataSchema = ManagedModificationExecutionContentSchema.omit({schemaVersion: true, request: true, sourceForm: true, result: true, resultRecordedAt: true});
export const ManagedModificationExecutionReceiptContentSchema = z.object({
  schemaVersion: z.literal("openpond.managedModificationExecutionReceipt.v1"),
  operationId: Id, requestHash: Hash, execution: ManagedModificationExecutionMetadataSchema,
}).strict();
export const ManagedModificationExecutionReceiptSchema = ManagedModificationExecutionReceiptContentSchema.extend({contentHash: Hash}).strict();
export type ManagedModificationExecutionReceipt = z.infer<typeof ManagedModificationExecutionReceiptSchema>;

/** Metadata-only creator history. A page grants neither execution nor capture authority. */
export const ManagedModificationExecutionListQuerySchema = z.object({
  id: Id.optional(), projectId: Id.optional(), method: ModelModificationMethodSchema.optional(),
  phase: ManagedModificationExecutionContentSchema.shape.phase.optional(),
  limit: z.number().int().min(1).max(100).default(25), cursor: z.string().min(1).max(2048).optional(),
}).strict();
export type ManagedModificationExecutionListQuery = z.input<typeof ManagedModificationExecutionListQuerySchema>;
export const ManagedModificationExecutionSummarySchema = ManagedModificationExecutionMetadataSchema.extend({
  model: ActivationReferenceRequestSchema.shape.model,
}).strict();
export type ManagedModificationExecutionSummary = z.infer<typeof ManagedModificationExecutionSummarySchema>;
export const ManagedModificationExecutionPageContentSchema = z.object({
  schemaVersion: z.literal("openpond.managedModificationExecutionPage.v1"), teamId: Id, ownerUserId: Id,
  query: ManagedModificationExecutionListQuerySchema,
  items: z.array(ManagedModificationExecutionSummarySchema).max(100),
  nextCursor: z.string().min(1).max(2048).nullable(),
}).strict();
export const ManagedModificationExecutionPageSchema = ManagedModificationExecutionPageContentSchema.extend({contentHash: Hash}).strict();
export type ManagedModificationExecutionPage = z.infer<typeof ManagedModificationExecutionPageSchema>;
export async function parseAndVerifyManagedModificationExecutionPage(raw: unknown, expected: {
  teamId: string; query?: ManagedModificationExecutionListQuery; ownerUserId?: string;
}): Promise<ManagedModificationExecutionPage> {
  const page = ManagedModificationExecutionPageSchema.parse(raw), {contentHash, ...content} = page;
  const query = ManagedModificationExecutionListQuerySchema.parse(expected.query ?? {});
  const invalid = () => new OpenPondProtocolError("managed_modification_history_mismatch", "The execution history differs from its requested scope.");
  if (page.teamId !== expected.teamId || expected.ownerUserId !== undefined && page.ownerUserId !== expected.ownerUserId ||
      canonicalJson(page.query) !== canonicalJson(query) || contentHash !== await canonicalSha256(content) ||
      page.items.length > query.limit || new Set(page.items.map(item => item.id)).size !== page.items.length ||
      page.nextCursor !== null && (page.items.length !== query.limit || page.nextCursor === query.cursor)) throw invalid();
  for (const [index, item] of page.items.entries()) {
    const previous = page.items[index - 1];
    assertManagedModificationPricing(item.plan);
    if (item.teamId !== page.teamId || item.ownerUserId !== page.ownerUserId ||
        query.id !== undefined && item.id !== query.id || query.projectId !== undefined && item.projectId !== query.projectId ||
        query.method !== undefined && item.method !== query.method || query.phase !== undefined && item.phase !== query.phase ||
        canonicalComputeSpendCap(item.plan.maximumSpendUsd) !== item.plan.maximumSpendUsd ||
        Date.parse(item.plan.expiresAt) <= Date.parse(item.plan.createdAt) ||
        previous && (Date.parse(previous.plan.createdAt) < Date.parse(item.plan.createdAt) ||
          Date.parse(previous.plan.createdAt) === Date.parse(item.plan.createdAt) && previous.id <= item.id)) throw invalid();
  }
  return page;
}

export function canonicalModificationSpend(value:string):string {
  const result=canonicalComputeSpendCap(Spend.parse(value));
  if(result===null) throw new OpenPondProtocolError("managed_modification_cap_invalid","Choose a positive spending limit.");
  return result;
}

export async function parseAndVerifyManagedModificationPrepare(raw: unknown): Promise<ManagedModificationPrepare> {
  const value = ManagedModificationPrepareSchema.parse(raw);
  value.maximumSpendUsd = canonicalComputeSpendCap(value.maximumSpendUsd);
  await parseAndVerifyActivationReferenceRequest(value.request);
  if (value.sourceForm) {
    parseManagedModificationCompile({teamId: value.teamId, projectId: value.projectId,
      method: value.method, query: value.query, form: value.sourceForm});
    verifySourceForm(value.sourceForm, value.request, value.maximumSpendUsd);
  }
  if (value.request.startingProfile && value.method !== "neuron_steering")
    throw new OpenPondProtocolError("managed_modification_saved_source_unsupported", "Saved steering sources currently require neuron steering.");
  const profiles = value.request.variants.filter(row => row.profile !== null).length;
  if (value.query.teamId !== value.teamId || value.query.modelId !== value.request.model.modelId ||
      value.query.revision !== value.request.model.revision ||
      (value.method === "inspect_activations" ? profiles > 0 : profiles === 0 || profiles === value.request.variants.length))
    throw new OpenPondProtocolError("managed_modification_input_invalid", "Retain the exact model and appropriate inspection or Off/intervention comparison.");
  if (new TextEncoder().encode(canonicalJson(value)).byteLength > 1_048_576)
    throw new OpenPondProtocolError("managed_modification_input_too_large", "The bounded activation request exceeds 1 MiB.");
  return value;
}
export function parseManagedModificationControl(raw: unknown): ManagedModificationStart | ManagedModificationCancel {
  const value = z.discriminatedUnion("action", [ManagedModificationStartSchema, ManagedModificationCancelSchema]).parse(raw);
  if (value.action === "start") value.approvedMaximumSpendUsd = canonicalComputeSpendCap(value.approvedMaximumSpendUsd);
  return value;
}
/** The receipt projects the original immutable owner receipt. Capture bytes are
 * read separately; a later execution read cannot replace mutation history. */
export async function parseAndVerifyManagedModificationExecutionReceipt(raw: unknown,
  input: ManagedModificationPrepare | ManagedModificationStart | ManagedModificationCancel) {
  const value = ManagedModificationExecutionReceiptSchema.parse(raw), {contentHash, ...content} = value;
  const command = "action" in input ? parseManagedModificationControl(input) : await parseAndVerifyManagedModificationPrepare(input);
  const execution = value.execution, prepare = !("action" in command);
  const expectedHash = await canonicalSha256(prepare ? {action: "prepare", command} : command);
  if (contentHash !== await canonicalSha256(content) || value.operationId !== command.operationId || value.requestHash !== expectedHash ||
      execution.teamId !== command.teamId || Date.parse(execution.plan.expiresAt) <= Date.parse(execution.plan.createdAt) ||
      execution.plan.maximumSpendUsd !== canonicalComputeSpendCap(execution.plan.maximumSpendUsd))
    throw new OpenPondProtocolError("managed_modification_receipt_mismatch", "The receipt differs from the original operation and reviewed execution.");
  if (prepare) {
    const request = command as ManagedModificationPrepare;
    const id = `modification-${await canonicalSha256({teamId: request.teamId, ownerUserId: execution.ownerUserId, operationId: request.operationId})}`;
    if (execution.id !== id || execution.projectId !== request.projectId || execution.name !== request.name || execution.method !== request.method ||
        execution.phase !== "prepared" || execution.revision !== 1 || execution.plan.inputHash !== await canonicalSha256(request.request) ||
        execution.plan.maximumSpendUsd !== request.maximumSpendUsd)
      throw new OpenPondProtocolError("managed_modification_receipt_mismatch", "The preparation differs from the requested bounded experiment.");
  } else {
    const request = command as ManagedModificationStart | ManagedModificationCancel;
    if (execution.id !== request.id || execution.revision !== request.expectedRevision + 1 || execution.plan.contentHash !== request.planHash ||
        (request.action === "start" ? execution.phase !== "queued" || execution.plan.maximumSpendUsd !== request.approvedMaximumSpendUsd || !await managedModificationPriceApprovalMatches(execution.plan,request)
          : !["cancelled", "stopping"].includes(execution.phase)))
      throw new OpenPondProtocolError("managed_modification_receipt_mismatch", "The action differs from the exact reviewed execution.");
  }
  return value;
}

export async function parseAndVerifyManagedModificationExecution(
  raw: unknown,
  expected: { teamId: string; id: string; ownerUserId?: string },
): Promise<ManagedModificationExecution> {
  const value = ManagedModificationExecutionSchema.parse(raw);
  const { contentHash, ...content } = value;
  const request = await parseAndVerifyActivationReferenceRequest(value.request);
  if (value.sourceForm) verifySourceForm(value.sourceForm, request, value.plan.maximumSpendUsd);
  if (request.startingProfile && value.method !== "neuron_steering") throw new OpenPondProtocolError("managed_modification_saved_source_unsupported", "Saved steering sources currently require neuron steering.");
  const profiles = request.variants.filter((row) => row.profile !== null).length;
  if (value.teamId !== expected.teamId || value.id !== expected.id ||
      expected.ownerUserId !== undefined && value.ownerUserId !== expected.ownerUserId ||
      contentHash !== await canonicalSha256(content) ||
      value.plan.inputHash !== await canonicalSha256(request) ||
      (value.method === "inspect_activations" ? profiles > 0 : profiles === 0 || profiles === request.variants.length) ||
      value.plan.maximumSpendUsd !== canonicalComputeSpendCap(value.plan.maximumSpendUsd) ||
      Boolean(value.result) !== Boolean(value.resultRecordedAt) ||
      Date.parse(value.plan.expiresAt) <= Date.parse(value.plan.createdAt))
    throw new OpenPondProtocolError("managed_modification_execution_mismatch", "The execution differs from its retained identity, request or capture.");
  if (value.result) await parseAndVerifyActivationReferenceResult(value.result, request);
  return value;
}

function verifySourceForm(form: z.infer<typeof ActivationExperimentFormDraftSchema>,
  request: z.infer<typeof ActivationReferenceRequestSchema>, maximumSpendUsd: string|null) {
  if (canonicalJson(form.startingProfile ?? null) !== canonicalJson(request.startingProfile ? activationStartingProfileSource(request.startingProfile) : null))
    throw new OpenPondProtocolError("managed_modification_authoring_mismatch", "Retain the exact saved steering source through preparation.");
  if (!form.baseModel || form.baseModel.modelId !== request.model.modelId ||
      form.baseModel.revision !== request.model.revision || canonicalComputeSpendCap(form.maximumSpendUsd) !== maximumSpendUsd)
    throw new OpenPondProtocolError("managed_modification_authoring_mismatch", "The retained form differs from this exact model or spending cap.");
}

// A full capture is bounded to 8 MiB and its exact request to 1 MiB. Keep
// envelope headroom here without increasing unrelated Training API reads.
export const MANAGED_MODIFICATION_EXECUTION_RESPONSE_MAX_BYTES = 10 * 1024 * 1024;
export function createManagedModificationExecutionClient(request: (path: string, init?: RequestInit, responseLimit?: number) => Promise<unknown>) {
  async function mutate(input: ManagedModificationPrepare | ManagedModificationStart | ManagedModificationCancel) {
    const value = "action" in input ? parseManagedModificationControl(input) : await parseAndVerifyManagedModificationPrepare(input);
    const path = "action" in value ? `/v1/training/modification-executions/${encodeURIComponent(value.id)}/${value.action}`
      : "/v1/training/modification-executions/prepare";
    return parseAndVerifyManagedModificationExecutionReceipt(await request(path, {method: "POST", body: canonicalJson(value)}), value);
  }
  return {
    async compileModificationExecution(input: ManagedModificationCompile) {
      const value = parseManagedModificationCompile(input);
      return parseAndVerifyManagedModificationCompilation(await request("/v1/training/modification-executions/compile",
        {method: "POST", body: canonicalJson(value)}), value);
    },
    prepareModificationExecution(input: ManagedModificationPrepare) { return mutate(input); },
    startModificationExecution(input: ManagedModificationStart) { return mutate(input); },
    cancelModificationExecution(input: ManagedModificationCancel) { return mutate(input); },
    async listModificationExecutions(teamId: string, query: ManagedModificationExecutionListQuery = {},
      options: {signal?: AbortSignal; ownerUserId?: string} = {}): Promise<ManagedModificationExecutionPage> {
      const team = Id.parse(teamId), parsed = ManagedModificationExecutionListQuerySchema.parse(query);
      const params = new URLSearchParams({teamId: team});
      for (const [key, value] of Object.entries(parsed)) params.set(key, String(value));
      return parseAndVerifyManagedModificationExecutionPage(await request(`/v1/training/modification-executions?${params}`,
        {signal: options.signal}), {teamId: team, query: parsed, ownerUserId: options.ownerUserId});
    },
    async getModificationExecution(teamId: string, id: string, options: { signal?: AbortSignal } = {}): Promise<ManagedModificationExecution> {
      const team = Id.parse(teamId), executionId = Id.parse(id);
      const params = new URLSearchParams({ teamId: team });
      return parseAndVerifyManagedModificationExecution(await request(
        `/v1/training/modification-executions/${encodeURIComponent(executionId)}?${params}`,
        { signal: options.signal },
        MANAGED_MODIFICATION_EXECUTION_RESPONSE_MAX_BYTES,
      ), { teamId: team, id: executionId });
    },
  };
}
