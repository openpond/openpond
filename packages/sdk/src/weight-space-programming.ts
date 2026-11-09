import { z } from "zod";
import { NeuronSteeringModelSchema } from "./neuron-steering.js";
import { ModelProjectVersionedRefSchema } from "./model-projects.js";
import { canonicalJson, canonicalSha256, OpenPondProtocolError } from "./protocol.js";

export const WeightSpaceHashSchema = z.string().regex(/^[a-f0-9]{64}$/);
export const WeightSpaceIdSchema = z.string().trim().min(1).max(240);
const Id = WeightSpaceIdSchema, Hash = WeightSpaceHashSchema;
export const WEIGHT_SPACE_MAX_PATCH_BYTES = 16_777_216;

/** One exact dense implementation. Catalog membership alone cannot enable it. */
export const WeightSpaceModelSchema = NeuronSteeringModelSchema.refine(model =>
  model.modelId === "Qwen/Qwen3-8B" && model.revision === "b968826d9c46dd6066d109eabc6255188de91218"
  && model.dtype === "bfloat16" && model.hiddenSize === 4096 && model.intermediateSizes.length === 36
  && model.intermediateSizes.every(size => size === 12288),
{ message: "Weight-space programming requires the exact supported dense BF16 Qwen3-8B checkpoint." });

export const WeightSpaceLimitsSchema = z.object({
  maximumDurationSeconds: z.number().int().min(1).max(21_600),
  maximumIdleSeconds: z.number().int().min(1).max(900),
  maximumCommands: z.number().int().min(1).max(512),
  maximumCandidates: z.number().int().min(1).max(64),
  maximumPatchColumns: z.number().int().min(1).max(128),
  maximumTensorElements: z.number().int().min(1).max(1_048_576),
  maximumReturnedValues: z.number().int().min(1).max(4096),
  maximumArithmeticWork: z.number().int().min(1).max(2_000_000_000),
  maximumForwardTokenWork: z.number().int().min(1).max(100_000_000),
  maximumCheckpointBytes: z.number().int().min(1).max(WEIGHT_SPACE_MAX_PATCH_BYTES),
}).strict().superRefine((limits, context) => {
  if (limits.maximumIdleSeconds > limits.maximumDurationSeconds)
    context.addIssue({ code: "custom", path: ["maximumIdleSeconds"], message: "Idle time must fit inside the original session duration." });
});
export type WeightSpaceLimits = z.infer<typeof WeightSpaceLimitsSchema>;

export const WeightSpacePromptSchema = z.object({
  id: Id, text: z.string().trim().min(1).max(32_768),
  system: z.string().max(32_768).optional(),
}).strict();
export const WeightSpacePanelSchema = z.object({
  id: Id, source: ModelProjectVersionedRefSchema.nullable(),
  role: z.enum(["development", "preservation"]),
  prompts: z.array(WeightSpacePromptSchema).min(1).max(64),
}).strict().superRefine((panel, context) => {
  if (new Set(panel.prompts.map(row => row.id)).size !== panel.prompts.length)
    context.addIssue({ code: "custom", path: ["prompts"], message: "Prompt identities must be distinct within a panel." });
});
export const WeightSpaceRequestSchema = z.object({
  schemaVersion: z.literal("openpond.weightSpaceRequest.v1"),
  model: WeightSpaceModelSchema,
  teacher: z.object({ controller: z.literal("local_agent"), providerId: Id, modelId: Id, sessionId: Id }).strict(),
  objective: z.string().trim().min(1).max(16_384),
  panels: z.array(WeightSpacePanelSchema).min(1).max(4),
  frozenEvaluation: ModelProjectVersionedRefSchema.nullable(),
  generation: z.object({ maxOutputTokens: z.number().int().min(1).max(2048), seed: z.number().int().nonnegative().max(2_147_483_647),
    sampling: z.literal("greedy_v1") }).strict(),
  limits: WeightSpaceLimitsSchema,
}).strict().superRefine((request, context) => {
  if (new Set(request.panels.map(row => row.id)).size !== request.panels.length || !request.panels.some(row => row.role === "development"))
    context.addIssue({ code: "custom", path: ["panels"], message: "Declare distinct development/preservation panels and at least one development panel." });
  const frozen = request.frozenEvaluation;
  if (frozen && request.panels.some(panel => panel.source?.id === frozen.id))
    context.addIssue({ code: "custom", path: ["frozenEvaluation"], message: "Frozen evaluation cannot be an editor-visible feedback panel." });
});
export type WeightSpaceRequest = z.infer<typeof WeightSpaceRequestSchema>;

/** Resolved by the evaluation owner, never supplied as an editing command.
 * Only policy-visible inputs cross into the tensor process. Graders and private
 * expected outputs stay with the scoring owner. */
export const WeightSpaceFrozenPanelSchema = z.object({
  source: ModelProjectVersionedRefSchema,
  prompts: z.array(WeightSpacePromptSchema).min(1).max(64),
}).strict().superRefine((panel, context) => {
  if (new Set(panel.prompts.map(row => row.id)).size !== panel.prompts.length)
    context.addIssue({ code: "custom", path: ["prompts"], message: "Frozen task identities must be distinct." });
  if (new TextEncoder().encode(canonicalJson(panel)).byteLength > 524_288)
    context.addIssue({ code: "custom", path: ["prompts"], message: "Keep resolved held-out inputs within 512 KiB." });
});
export type WeightSpaceFrozenPanel = z.infer<typeof WeightSpaceFrozenPanelSchema>;

export const WeightSpaceColumnsSchema = z.object({
  layer: z.number().int().min(0).max(35),
  columns: z.array(z.number().int().min(0).max(12287)).min(1).max(128),
}).strict().superRefine((value, context) => {
  if (value.columns.some((column, index) => index > 0 && column <= value.columns[index - 1]!))
    context.addIssue({ code: "custom", path: ["columns"], message: "Column indices must be distinct and increasing." });
});

const Variable = z.string().regex(/^[a-z][a-z0-9_]{0,39}$/);
/** A numerical program, not Python source. No imports, file/network access,
 * autograd, optimization or hidden forward passes are expressible here. */
export const WeightSpaceInstructionSchema = z.discriminatedUnion("op", [
  z.object({op:z.literal("read_tensor"),out:Variable,name:z.string().min(1).max(240),source:z.enum(["base","candidate"]),
    ranges:z.array(z.object({start:z.number().int().nonnegative(),stop:z.number().int().positive()}).strict()).min(1).max(2)}).strict(),
  z.object({ op: z.literal("read"), out: Variable, source: z.enum(["base", "candidate"]), ...WeightSpaceColumnsSchema.shape }).strict(),
  z.object({ op: z.literal("literal"), out: Variable, shape: z.array(z.number().int().min(1).max(4096)).min(1).max(2),
    values: z.array(z.number().finite()).min(1).max(4096) }).strict(),
  z.object({ op: z.literal("scale"), out: Variable, input: Variable, factor: z.number().finite() }).strict(),
  z.object({ op: z.enum(["add", "subtract", "matmul"]), out: Variable, left: Variable, right: Variable }).strict(),
  z.object({ op: z.enum(["transpose", "normalize_columns", "mean_columns", "singular_vectors"]), out: Variable, input: Variable }).strict(),
  z.object({ op: z.literal("slice"), out: Variable, input: Variable, axis: z.number().int().min(0).max(1),
    start: z.number().int().nonnegative(), stop: z.number().int().positive() }).strict(),
  z.object({ op: z.literal("write"), input: Variable, ...WeightSpaceColumnsSchema.shape }).strict(),
]);
export const WeightSpaceProgramSchema = z.object({
  instructions: z.array(WeightSpaceInstructionSchema).min(1).max(64),
  returns: z.array(Variable).max(8),
}).strict().superRefine((program, context) => {
  const variables = new Set<string>();
  for (const [index, instruction] of program.instructions.entries()) {
    const inputs = "input" in instruction ? [instruction.input] : "left" in instruction ? [instruction.left, instruction.right] : [];
    if (inputs.some(name => !variables.has(name)) || "out" in instruction && variables.has(instruction.out))
      context.addIssue({ code: "custom", path: ["instructions", index], message: "Use existing inputs and a distinct output name for each instruction." });
    if ("out" in instruction) variables.add(instruction.out);
    if ("columns" in instruction && !WeightSpaceColumnsSchema.safeParse({layer:instruction.layer,columns:instruction.columns}).success)
      context.addIssue({code:"custom",path:["instructions",index],message:"Use distinct ordered columns within the editable layer."});
    if (instruction.op === "literal" && instruction.shape.reduce((a, b) => a * b, 1) !== instruction.values.length)
      context.addIssue({ code: "custom", path: ["instructions", index], message: "Literal shape and values must agree." });
    if (instruction.op === "slice" && instruction.start >= instruction.stop)
      context.addIssue({ code: "custom", path: ["instructions", index], message: "Slice bounds must increase." });
  }
  if (new Set(program.returns).size !== program.returns.length || program.returns.some(name => !variables.has(name)))
    context.addIssue({ code: "custom", path: ["returns"], message: "Return distinct existing variables." });
});
export type WeightSpaceProgram = z.infer<typeof WeightSpaceProgramSchema>;

const commandIdentity = { teamId: Id, sessionId: Id, operationId: Id,
  expectedRevision: z.number().int().positive(), candidateHash: Hash };
export const WeightSpaceCommandSchema = z.discriminatedUnion("action", [
  z.object({...commandIdentity,action:z.literal("catalog"),offset:z.number().int().nonnegative().max(10000),limit:z.number().int().min(1).max(128)}).strict(),
  z.object({ ...commandIdentity, action: z.literal("inspect"), ...WeightSpaceColumnsSchema.shape }).strict(),
  z.object({ ...commandIdentity, action: z.literal("program"), program: WeightSpaceProgramSchema,
    hypothesis: z.string().trim().min(1).max(4096) }).strict(),
  z.object({...commandIdentity,action:z.literal("code"),code:z.string().min(1).max(32768),hypothesis:z.string().trim().min(1).max(4096)}).strict(),
  z.object({ ...commandIdentity, action: z.literal("evaluate"), panelId: Id }).strict(),
  z.object({ ...commandIdentity, action: z.literal("select"), targetCandidateHash: Hash }).strict(),
  z.object({ ...commandIdentity, action: z.literal("finalize") }).strict(),
]).superRefine((command,context)=>{
  if(command.action==="inspect"&&!WeightSpaceColumnsSchema.safeParse({layer:command.layer,columns:command.columns}).success)
    context.addIssue({code:"custom",path:["columns"],message:"Use distinct increasing column indices."});
});
export type WeightSpaceCommand = z.infer<typeof WeightSpaceCommandSchema>;

export const WeightSpaceTensorSummarySchema = z.object({
  shape: z.array(z.number().int().positive()).min(1).max(2),
  minimum: z.number().finite(), maximum: z.number().finite(), mean: z.number().finite(), norm: z.number().finite(),
  values: z.array(z.number().finite()).max(4096), truncated: z.boolean(),
}).strict();
export const WeightSpaceEvaluationSchema = z.object({
  panelId: Id, role: z.enum(["development", "preservation"]), candidateHash: Hash,
  sampling: z.literal("greedy_v1"), seed: z.number().int().nonnegative(),
  rows: z.array(z.object({ id: Id, inputHash: Hash, outputIds: z.array(z.number().int().nonnegative()).min(1).max(2048),
    outputText: z.string().max(65_536),
    reachedTokenLimit: z.boolean(), forwardTokenWork: z.number().int().positive() }).strict()).min(1).max(64),
}).strict();
export const WeightSpaceFrozenEvaluationSchema = WeightSpaceEvaluationSchema.extend({
  role: z.literal("frozen"), source: ModelProjectVersionedRefSchema,
  baseline: z.object({candidateHash:Hash,rows:WeightSpaceEvaluationSchema.shape.rows}).strict(),
}).strict();

/** Shared by the authoritative result owner and portable consumers. Token work
 * is full attended context per forward, even when inference uses a KV cache. */
export async function verifyWeightSpaceEvaluation(
  value: z.infer<typeof WeightSpaceEvaluationSchema> | z.infer<typeof WeightSpaceFrozenEvaluationSchema>,
  request: WeightSpaceRequest,
  panel: { id: string; role: "development" | "preservation" | "frozen"; prompts: z.infer<typeof WeightSpacePromptSchema>[] },
  candidateHash: string,
) {
  if (value.panelId !== panel.id || value.role !== panel.role || value.candidateHash !== candidateHash
    || value.seed !== request.generation.seed || value.sampling !== request.generation.sampling
    || value.rows.length !== panel.prompts.length)
    throw new OpenPondProtocolError("weight_space_evaluation_mismatch", "Evaluation differs from its pinned candidate, inputs or generation settings.");
  for (const [index, row] of value.rows.entries()) {
    const n = row.outputIds.length, triangular = n * (n - 1) / 2;
    const promptTokens = (row.forwardTokenWork - triangular) / n;
    if (row.id !== panel.prompts[index]!.id || row.inputHash !== await canonicalSha256(panel.prompts[index])
      || n < 1 || n > request.generation.maxOutputTokens
      || row.reachedTokenLimit && n !== request.generation.maxOutputTokens
      || !Number.isInteger(promptTokens) || promptTokens < 1 || promptTokens + n - 1 > 8192)
      throw new OpenPondProtocolError("weight_space_evaluation_mismatch", "Evaluation rows differ from their declared inputs or bounded forward work.");
  }
  return value;
}
export const WeightSpaceCommandResultContentSchema = z.object({
  schemaVersion: z.literal("openpond.weightSpaceCommandResult.v1"),
  sessionId: Id, operationId: Id, requestHash: Hash, revision: z.number().int().positive(),
  parentCandidateHash: Hash, candidateHash: Hash, changedColumns: z.array(WeightSpaceColumnsSchema).max(36),
  status: z.enum(["succeeded", "rejected"]), code: z.string().min(1).max(100).nullable(),
  catalog:z.object({items:z.array(z.object({name:z.string().min(1).max(240),shape:z.array(z.number().int().positive()).min(1).max(2),dtype:z.literal("BF16"),editable:z.boolean()}).strict()).max(128),nextOffset:z.number().int().nonnegative().nullable()}).strict().nullable(),
  tensors: z.record(Variable, WeightSpaceTensorSummarySchema), evaluation: WeightSpaceEvaluationSchema.nullable(),
  finalEvaluation: WeightSpaceFrozenEvaluationSchema.nullable().optional(),
  usage: z.object({ commands: z.number().int().nonnegative(), candidates: z.number().int().nonnegative(),
    arithmeticWork: z.number().int().nonnegative(), forwardTokenWork: z.number().int().nonnegative() }).strict(),
}).strict();
export const WeightSpaceCommandResultSchema = WeightSpaceCommandResultContentSchema.extend({ contentHash: Hash });
export type WeightSpaceCommandResult = z.infer<typeof WeightSpaceCommandResultSchema>;

export async function parseAndVerifyWeightSpaceCommandResult(raw: unknown, command: WeightSpaceCommand) {
  const value = WeightSpaceCommandResultSchema.parse(raw), { contentHash, ...content } = value;
  if (contentHash !== await canonicalSha256(content) || value.sessionId !== command.sessionId
    || value.operationId !== command.operationId || value.requestHash !== await canonicalSha256(command)
    || value.parentCandidateHash !== command.candidateHash || value.revision !== command.expectedRevision + 1
    || value.status === "rejected" && (value.candidateHash !== command.candidateHash || value.code === null)
    || value.status === "succeeded" && (value.code !== null
      || command.action === "evaluate" && value.evaluation === null
      || !["program", "code", "select"].includes(command.action) && value.candidateHash !== command.candidateHash
      || command.action === "select" && value.candidateHash !== command.targetCandidateHash)
    || value.catalog!==null && command.action!=="catalog"
    || value.status === "succeeded" && command.action==="catalog" && value.catalog===null
    || value.status === "rejected" && (value.catalog!==null||value.evaluation !== null || Object.keys(value.tensors).length > 0)
    || value.finalEvaluation != null && (command.action !== "finalize" || value.status !== "succeeded"
      || value.finalEvaluation.candidateHash !== command.candidateHash || value.finalEvaluation.panelId !== value.finalEvaluation.source.id
      || value.finalEvaluation.baseline.candidateHash===value.finalEvaluation.candidateHash
      || value.finalEvaluation.baseline.rows.length!==value.finalEvaluation.rows.length
      || value.finalEvaluation.baseline.rows.some((row,index)=>row.id!==value.finalEvaluation!.rows[index]!.id
        ||row.inputHash!==value.finalEvaluation!.rows[index]!.inputHash))
    || value.changedColumns.some((row,index) => index > 0 && row.layer <= value.changedColumns[index-1]!.layer)
    || value.changedColumns.reduce((sum,row) => sum+row.columns.length,0)>128
    || value.evaluation && (command.action !== "evaluate" || value.evaluation.panelId !== command.panelId
      || value.evaluation.candidateHash !== command.candidateHash))
    throw new OpenPondProtocolError("weight_space_result_mismatch", "The editing receipt differs from the exact command and candidate.");
  const summaries=Object.values(value.tensors);
  if(summaries.length>8||summaries.reduce((n,row)=>n+row.values.length,0)>4096
    ||summaries.some(row=>{const count=row.shape.reduce((n,size)=>n*size,1);return count>1_048_576||row.values.length>count||row.truncated!==(row.values.length<count)||row.minimum>row.maximum||row.norm<0;})
    ||value.catalog&&command.action==="catalog"&&(value.catalog.items.length>command.limit
      ||value.catalog.items.some((row,index)=>index>0&&row.name<=value.catalog!.items[index-1]!.name)
      ||value.catalog.nextOffset!==null&&(value.catalog.items.length!==command.limit||value.catalog.nextOffset!==command.offset+command.limit)))
    throw new OpenPondProtocolError("weight_space_result_mismatch","The inspection exceeds its bounded tensor or catalog contract.");
  return value;
}

export function weightSpaceBaseCandidateHash(request: WeightSpaceRequest) {
  return canonicalSha256({ schemaVersion: "openpond.weightSpaceCandidate.v1", model: request.model, columns: [] });
}
export async function parseAndVerifyWeightSpaceRequest(raw: unknown) {
  const value = WeightSpaceRequestSchema.parse(raw);
  if (new TextEncoder().encode(canonicalJson(value)).byteLength > 1_048_576)
    throw new OpenPondProtocolError("weight_space_request_too_large", "Keep editing inputs within the admitted request budget.");
  return value;
}
