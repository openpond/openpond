import { canonicalComputeSpendCap, managedModificationPriceApprovalMatches } from "./managed-compute-price.js";
import { z } from "zod";
import { canonicalJson, canonicalSha256, OpenPondProtocolError } from "./protocol.js";
import { ManagedModificationExecutionMetadataSchema, ManagedModificationStartSchema, ManagedModificationCancelSchema } from "./managed-modification-executions.js";
import { ModelModificationCapabilitiesQuerySchema, ModelModificationValidationLevelSchema } from "./model-modification-capabilities.js";
import { WeightSpaceCommandSchema, WeightSpaceCommandResultSchema, WeightSpaceHashSchema as Hash, WeightSpaceIdSchema as Id,
  WeightSpaceLimitsSchema, WeightSpaceModelSchema, WeightSpaceRequestSchema, parseAndVerifyWeightSpaceRequest,
  parseAndVerifyWeightSpaceCommandResult, type WeightSpaceCommand } from "./weight-space-programming.js";
import { WeightSpaceResultSchema, parseAndVerifyWeightSpaceResult } from "./weight-space-artifact.js";

const Method = z.literal("weight_space_programming");
export const WeightSpaceCapabilityContentSchema = z.object({
  schemaVersion: z.literal("openpond.weightSpaceCapability.v1"), teamId: Id, actorId: Id,
  query: ModelModificationCapabilitiesQuerySchema, requestHash: Hash, checkedAt: z.iso.datetime(), expiresAt: z.iso.datetime(),
  validationLevel: ModelModificationValidationLevelSchema.nullable(),
  execution: z.discriminatedUnion("state", [
    z.object({ state: z.literal("unavailable"), code: z.enum(["model_not_supported", "runtime_not_qualified"]),
      reason: z.string().min(1).max(1000) }).strict(),
    z.object({ state: z.literal("ready"), model: WeightSpaceModelSchema,
      runtime: z.object({ id: Id, releaseHash: Hash, imageDigest: z.string().regex(/^sha256:[a-f0-9]{64}$/),
        requestSchema: z.literal("openpond.weightSpaceRequest.v1"), evidence: z.object({ id: Id, contentHash: Hash }).strict() }).strict(),
      limits: WeightSpaceLimitsSchema }).strict(),
  ]),
}).strict();
export const WeightSpaceCapabilitySchema = WeightSpaceCapabilityContentSchema.extend({ contentHash: Hash });
export type WeightSpaceCapability = z.infer<typeof WeightSpaceCapabilitySchema>;
export const WeightSpacePrepareSchema = z.object({
  teamId: Id, operationId: Id, projectId: Id.nullable(), name: z.string().trim().min(1).max(500), method: Method,
  query: ModelModificationCapabilitiesQuerySchema, request: WeightSpaceRequestSchema,
  maximumSpendUsd: z.string().regex(/^(0|[1-9]\d*)(\.\d{1,6})?$/).max(48),
  sourceForm: z.never().optional(),
}).strict();
export type WeightSpacePrepare = z.infer<typeof WeightSpacePrepareSchema>;
export const WeightSpaceSessionStateSchema = z.object({
  revision: z.number().int().positive(), candidateHash: Hash, historyHash: Hash,
  phase: z.enum(["starting", "ready", "busy", "finalizing", "closed"]),
  pendingOperationId: Id.nullable(), lastActivityAt: z.iso.datetime(),
  finalization:z.object({operationId:Id,resultHash:Hash,historyHashBefore:Hash,status:z.enum(["succeeded","rejected"])}).strict().nullable(),
  usage: WeightSpaceCommandResultSchema.shape.usage,
}).strict();
export const WeightSpaceExecutionMetadataSchema = ManagedModificationExecutionMetadataSchema.omit({ method: true })
  .extend({ method: Method, session: WeightSpaceSessionStateSchema.nullable() }).strict();
export const WeightSpaceExecutionContentSchema = WeightSpaceExecutionMetadataSchema.extend({
  schemaVersion: z.literal("openpond.weightSpaceExecution.v1"), request: WeightSpaceRequestSchema,
  result: WeightSpaceResultSchema.nullable(), resultRecordedAt: z.iso.datetime().nullable(),
}).strict();
export const WeightSpaceExecutionSchema = WeightSpaceExecutionContentSchema.extend({ contentHash: Hash });
export type WeightSpaceExecution = z.infer<typeof WeightSpaceExecutionSchema>;
export const WeightSpaceExecutionReceiptContentSchema = z.object({
  schemaVersion: z.literal("openpond.weightSpaceExecutionReceipt.v1"), operationId: Id, requestHash: Hash,
  execution: WeightSpaceExecutionMetadataSchema,
}).strict();
export const WeightSpaceExecutionReceiptSchema = WeightSpaceExecutionReceiptContentSchema.extend({ contentHash: Hash });
export const WeightSpaceCommandReceiptContentSchema = z.object({
  schemaVersion: z.literal("openpond.weightSpaceCommandReceipt.v1"), teamId: Id, ownerUserId: Id,
  command: WeightSpaceCommandSchema, requestHash: Hash, state: z.enum(["queued", "completed"]),
  result: WeightSpaceCommandResultSchema.nullable(),
}).strict();
export const WeightSpaceCommandReceiptSchema = WeightSpaceCommandReceiptContentSchema.extend({ contentHash: Hash });
export const WeightSpaceExecutionListQuerySchema = z.object({
  method: Method.default("weight_space_programming"), projectId: Id.optional(), id: Id.optional(),
  phase: WeightSpaceExecutionMetadataSchema.shape.phase.optional(), cursor: z.string().min(1).max(2000).optional(),
  limit: z.number().int().min(1).max(100).default(25),
}).strict();
export const WeightSpaceExecutionPageContentSchema = z.object({
  schemaVersion: z.literal("openpond.weightSpaceExecutionPage.v1"), teamId: Id, ownerUserId: Id,
  query: WeightSpaceExecutionListQuerySchema,
  items: z.array(WeightSpaceExecutionMetadataSchema.extend({ model: WeightSpaceModelSchema })).max(100),
  nextCursor: z.string().min(1).max(2000).nullable(),
}).strict();
export const WeightSpaceExecutionPageSchema = WeightSpaceExecutionPageContentSchema.extend({ contentHash: Hash });
export type WeightSpaceExecutionPage = z.infer<typeof WeightSpaceExecutionPageSchema>;

export const WeightSpaceCommandListQuerySchema=z.object({afterRevision:z.number().int().nonnegative().default(0),limit:z.number().int().min(1).max(5).default(5)}).strict();
export const WeightSpaceCommandPageContentSchema=z.object({schemaVersion:z.literal("openpond.weightSpaceCommandPage.v1"),
  teamId:Id,ownerUserId:Id,sessionId:Id,query:WeightSpaceCommandListQuerySchema,items:z.array(WeightSpaceCommandReceiptSchema).max(5),nextAfterRevision:z.number().int().positive().nullable()}).strict();
export const WeightSpaceCommandPageSchema=WeightSpaceCommandPageContentSchema.extend({contentHash:Hash});
export async function parseAndVerifyWeightSpaceCommandPage(raw:unknown,expected:{teamId:string;sessionId:string;query:z.infer<typeof WeightSpaceCommandListQuerySchema>}){
  const value=await sealed(WeightSpaceCommandPageSchema.parse(raw));
  if(value.teamId!==expected.teamId||value.sessionId!==expected.sessionId||canonicalJson(value.query)!==canonicalJson(expected.query)
    ||value.items.length>expected.query.limit||new Set(value.items.map(row=>row.command.operationId)).size!==value.items.length)reject();
  let revision=expected.query.afterRevision;
  for(const row of value.items){
    await parseAndVerifyWeightSpaceCommandReceipt(row,row.command);
    if(row.teamId!==value.teamId||row.ownerUserId!==value.ownerUserId||row.command.sessionId!==value.sessionId||row.command.expectedRevision<=revision)reject();
    revision=row.command.expectedRevision;
  }
  if(value.nextAfterRevision!==null&&(value.items.length!==expected.query.limit||value.nextAfterRevision!==revision))reject();
  return value;
}

function reject(): never { throw new OpenPondProtocolError("weight_space_session_mismatch", "The weight-editing session differs from its exact workspace, source or operation."); }
async function sealed<T extends { contentHash: string }>(value: T) {
  const { contentHash, ...content } = value;
  if (contentHash !== await canonicalSha256(content)) reject();
  return value;
}
export async function parseAndVerifyWeightSpaceCapability(raw: unknown, query: z.infer<typeof ModelModificationCapabilitiesQuerySchema>, actorId?: string) {
  const value = await sealed(WeightSpaceCapabilitySchema.parse(raw));
  if (value.teamId !== query.teamId || actorId !== undefined && value.actorId !== actorId
    || canonicalJson(value.query) !== canonicalJson(query) || value.requestHash !== await canonicalSha256(query)
    || (value.execution.state === "ready") !== (value.validationLevel !== null)
    || Date.parse(value.checkedAt) > Date.now() + 30_000 || Date.parse(value.expiresAt) <= Date.now()
    || Date.parse(value.expiresAt) <= Date.parse(value.checkedAt) || Date.parse(value.expiresAt) - Date.parse(value.checkedAt) > 300_000) reject();
  return value;
}
export async function parseAndVerifyWeightSpacePrepare(raw: unknown) {
  const value = WeightSpacePrepareSchema.parse(raw);
  await parseAndVerifyWeightSpaceRequest(value.request);
  value.maximumSpendUsd = canonicalComputeSpendCap(value.maximumSpendUsd)!;
  if (value.query.teamId !== value.teamId || value.query.source !== "managed" || value.query.modelAssetId !== undefined
    || value.query.modelId !== value.request.model.modelId || value.query.revision !== value.request.model.revision
    || !value.query.tokenizerRevision || !value.query.chatTemplateHash || Number(value.maximumSpendUsd) <= 0) reject();
  return value;
}
export async function parseAndVerifyWeightSpaceExecution(raw: unknown, expected: { teamId: string; id: string; ownerUserId?: string }) {
  const value = await sealed(WeightSpaceExecutionSchema.parse(raw));
  if (value.teamId !== expected.teamId || value.id !== expected.id || expected.ownerUserId !== undefined && value.ownerUserId !== expected.ownerUserId
    || value.plan.inputHash !== await canonicalSha256(value.request)
    || (value.result === null) !== (value.resultRecordedAt === null)) reject();
  const session=value.session,limits=value.request.limits;
  if(session){
    if(session.revision!==session.usage.commands+1 || session.usage.commands>limits.maximumCommands
      ||session.usage.candidates>limits.maximumCandidates||session.usage.arithmeticWork>limits.maximumArithmeticWork
      ||session.usage.forwardTokenWork>limits.maximumForwardTokenWork
      ||(session.finalization!==null)!==(session.phase==="closed")
      ||(session.pendingOperationId!==null)!==(["busy","finalizing"].includes(session.phase)))reject();
    if(session.finalization){
      const command={teamId:value.teamId,sessionId:value.id,operationId:session.finalization.operationId,
        expectedRevision:session.revision-1,candidateHash:session.candidateHash,action:"finalize"};
      if(session.historyHash!==await canonicalSha256({previous:session.finalization.historyHashBefore,
        requestHash:await canonicalSha256(command),resultHash:session.finalization.resultHash}))reject();
    }
  }
  if (value.result) {
    await parseAndVerifyWeightSpaceResult(value.result, { request: value.request, runtimeHash: value.plan.runtimeHash });
    if(!session?.finalization||session.finalization.status!=="succeeded"||value.result.candidateHash!==session.candidateHash||value.result.historyHash!==session.finalization.historyHashBefore
      ||value.result.commands!==session.usage.commands||value.result.candidates!==session.usage.candidates
      ||value.result.forwardTokenWork!==session.usage.forwardTokenWork)reject();
  }
  return value;
}
export async function parseAndVerifyWeightSpaceExecutionReceipt(raw: unknown, command: WeightSpacePrepare | z.infer<typeof ManagedModificationStartSchema> | z.infer<typeof ManagedModificationCancelSchema>) {
  const value = await sealed(WeightSpaceExecutionReceiptSchema.parse(raw));
  const controlling = "action" in command;
  if (value.operationId !== command.operationId || value.execution.teamId !== command.teamId
    || value.requestHash !== await canonicalSha256(controlling ? command : { action: "prepare", command })
    || controlling && (value.execution.id !== command.id || value.execution.plan.contentHash !== command.planHash
      || value.execution.revision !== command.expectedRevision + 1)
    || !controlling && (value.execution.projectId !== command.projectId || value.execution.plan.inputHash !== await canonicalSha256(command.request))) reject();
  const execution=value.execution;
  if(controlling){
    if(command.action === "start" ? execution.phase!=="queued" || execution.plan.maximumSpendUsd!==command.approvedMaximumSpendUsd
      || !await managedModificationPriceApprovalMatches(execution.plan,command) : !["cancelled","stopping"].includes(execution.phase)) reject();
  }else if(execution.id!==`modification-${await canonicalSha256({teamId:command.teamId,ownerUserId:execution.ownerUserId,operationId:command.operationId})}`
    ||execution.name!==command.name||execution.phase!=="prepared"||execution.revision!==1||execution.plan.maximumSpendUsd!==command.maximumSpendUsd) reject();
  return value;
}
export async function parseAndVerifyWeightSpaceCommandReceipt(raw: unknown, command: WeightSpaceCommand) {
  const value = await sealed(WeightSpaceCommandReceiptSchema.parse(raw));
  if (value.teamId !== command.teamId || canonicalJson(value.command) !== canonicalJson(command)
    || value.requestHash !== await canonicalSha256(command) || (value.state === "completed") !== (value.result !== null)) reject();
  if (value.result) await parseAndVerifyWeightSpaceCommandResult(value.result, command);
  return value;
}
export async function parseAndVerifyWeightSpaceExecutionPage(raw: unknown, expected: { teamId: string; ownerUserId?: string; query: z.infer<typeof WeightSpaceExecutionListQuerySchema> }) {
  const value = await sealed(WeightSpaceExecutionPageSchema.parse(raw));
  if (value.teamId !== expected.teamId || expected.ownerUserId !== undefined && value.ownerUserId !== expected.ownerUserId
    || canonicalJson(value.query) !== canonicalJson(expected.query) || value.items.length > expected.query.limit
    || new Set(value.items.map(row => row.id)).size !== value.items.length
    || value.items.some(row => row.teamId !== value.teamId || row.ownerUserId !== value.ownerUserId
      || expected.query.projectId !== undefined && row.projectId !== expected.query.projectId
      ||expected.query.id!==undefined&&row.id!==expected.query.id||expected.query.phase!==undefined&&row.phase!==expected.query.phase)
    || value.nextCursor !== null && value.nextCursor === expected.query.cursor) reject();
  return value;
}

export function createWeightSpaceClient(request: (path: string, init?: RequestInit) => Promise<unknown>) {
  const root = "/v1/training/weight-space-sessions";
  const post = (path: string, body: unknown) => request(path, { method: "POST", body: canonicalJson(body) });
  return {
    async weightSpaceCapability(query: z.infer<typeof ModelModificationCapabilitiesQuerySchema>) {
      const input = ModelModificationCapabilitiesQuerySchema.parse(query);
      return parseAndVerifyWeightSpaceCapability(await post(`${root}/capability`, input), input);
    },
    async prepareWeightSpaceSession(raw: WeightSpacePrepare) {
      const input = await parseAndVerifyWeightSpacePrepare(raw);
      return parseAndVerifyWeightSpaceExecutionReceipt(await post(`${root}/prepare`, input), input);
    },
    async startWeightSpaceSession(raw: z.infer<typeof ManagedModificationStartSchema>) {
      const input = ManagedModificationStartSchema.parse(raw);
      return parseAndVerifyWeightSpaceExecutionReceipt(await post(`${root}/${encodeURIComponent(input.id)}/start`, input), input);
    },
    async cancelWeightSpaceSession(raw: z.infer<typeof ManagedModificationCancelSchema>) {
      const input = ManagedModificationCancelSchema.parse(raw);
      return parseAndVerifyWeightSpaceExecutionReceipt(await post(`${root}/${encodeURIComponent(input.id)}/cancel`, input), input);
    },
    async getWeightSpaceSession(teamId: string, id: string, options?:{ownerUserId?:string;signal?:AbortSignal}) {
      return parseAndVerifyWeightSpaceExecution(await request(`${root}/${encodeURIComponent(Id.parse(id))}?${new URLSearchParams({ teamId: Id.parse(teamId) })}`,{signal:options?.signal}), { teamId, id,ownerUserId:options?.ownerUserId });
    },
    async listWeightSpaceSessions(teamId: string, raw: z.input<typeof WeightSpaceExecutionListQuerySchema> = {}) {
      const query = WeightSpaceExecutionListQuerySchema.parse(raw), params = new URLSearchParams({ teamId: Id.parse(teamId) });
      for (const [key, value] of Object.entries(query)) params.set(key, String(value));
      return parseAndVerifyWeightSpaceExecutionPage(await request(`${root}?${params}`), { teamId, query });
    },
    async listWeightSpaceCommands(teamId:string,id:string,raw:z.input<typeof WeightSpaceCommandListQuerySchema>={}){
      const query=WeightSpaceCommandListQuerySchema.parse(raw),params=new URLSearchParams({teamId:Id.parse(teamId),afterRevision:String(query.afterRevision),limit:String(query.limit)});
      return parseAndVerifyWeightSpaceCommandPage(await request(`${root}/${encodeURIComponent(Id.parse(id))}/commands?${params}`),{teamId,sessionId:id,query});
    },
    async commandWeightSpaceSession(raw: WeightSpaceCommand) {
      const input = WeightSpaceCommandSchema.parse(raw);
      return parseAndVerifyWeightSpaceCommandReceipt(await post(`${root}/${encodeURIComponent(input.sessionId)}/commands`, input), input);
    },
    async getWeightSpaceCommand(teamId: string, sessionId: string, operationId: string) {
      const raw = await request(`${root}/${encodeURIComponent(Id.parse(sessionId))}/commands/${encodeURIComponent(Id.parse(operationId))}?${new URLSearchParams({ teamId: Id.parse(teamId) })}`);
      const value = WeightSpaceCommandReceiptSchema.parse(raw);
      if (value.teamId !== teamId || value.command.sessionId !== sessionId || value.command.operationId !== operationId) reject();
      return parseAndVerifyWeightSpaceCommandReceipt(value, value.command);
    },
  };
}
