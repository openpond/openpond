import { z } from "zod";
import { assertContentHash } from "@openpond/harness";
import { TasksetRunManifestSchema, TasksetRunMemberSchema, TasksetMetricResultSchema, assertTasksetMetricResult, orderTasksetRunReceipts } from "@openpond/evals/metrics";
import { AttemptReceiptSchema } from "@openpond/evals/runs";
import { ModelProjectVersionedRefSchema } from "./model-projects.js";
import { ModelStarterAttemptPolicySchema, ModelStarterAttemptSummarySchema } from "./model-starter-attempts.js";
import { canonicalJson, canonicalSha256 } from "./protocol.js";

const IdSchema = z.string().trim().min(1).max(200);
const HashSchema = z.string().regex(/^[a-f0-9]{64}$/);
export const ModelTasksetRunPolicySchema = z.discriminatedUnion("kind", [
  ModelStarterAttemptPolicySchema.options[0],
  z.object({ kind: z.literal("fixture") }).strict(),
]);
export const ModelTasksetRunRequestSchema = z.object({
  schemaVersion: z.literal("openpond.modelTasksetRunRequest.v1"),
  operationId: IdSchema, teamId: IdSchema, modelProjectId: IdSchema,
  taskset: ModelProjectVersionedRefSchema, policy: ModelTasksetRunPolicySchema,
  population: z.array(TasksetRunMemberSchema).min(1).max(10_000),
}).strict().superRefine((value, context) => {
  if (new Set(value.population.map(member => member.receiptId)).size !== value.population.length) context.addIssue({ code: "custom", path: ["population"], message: "Run receipt identities must be unique." });
  if (value.population.some(member => (member.fixtureId !== null) !== (value.policy.kind === "fixture"))) context.addIssue({ code: "custom", path: ["population"], message: "Only fixture runs require a fixture identity for every member." });
  if (value.population.some(member => !/^(0|[1-9][0-9]*)$/.test(member.seed) || Number(member.seed) > 2_147_483_647)) context.addIssue({ code: "custom", path: ["population"], message: "Hosted environment seeds must be integers from 0 to 2147483647." });
});
export type ModelTasksetRunRequest = z.infer<typeof ModelTasksetRunRequestSchema>;
export const ModelTasksetRunSummarySchema = z.object({
  schemaVersion: z.literal("openpond.modelTasksetRunSummary.v1"),
  id: IdSchema, revision: z.number().int().positive(), teamId: IdSchema, modelProjectId: IdSchema,
  operationId: IdSchema, taskset: ModelProjectVersionedRefSchema, policyKind: z.enum(["hosted_chat", "fixture"]),
  manifestHash: HashSchema,
  status: z.enum(["queued", "running", "cancelling", "completed", "failed", "cancelled"]),
  totalCount: z.number().int().min(1).max(10_000),
  counts: z.object({ pending: z.number().int().nonnegative(), running: z.number().int().nonnegative(), completed: z.number().int().nonnegative(), failed: z.number().int().nonnegative(), cancelled: z.number().int().nonnegative() }).strict(),
  createdAt: z.iso.datetime(), startedAt: z.iso.datetime().nullable(), completedAt: z.iso.datetime().nullable(),
  cleanupComplete: z.boolean(), resultAvailable: z.boolean(), score: z.number().min(0).max(1).nullable(),
  metricName: z.string().min(1).max(240),
  error: z.object({ code: IdSchema, message: z.string().max(2_000) }).strict().nullable(),
}).strict().superRefine((value, context) => {
  if (Object.values(value.counts).reduce((sum, count) => sum + count, 0) !== value.totalCount) context.addIssue({ code: "custom", path: ["counts"], message: "Run counts must account for the complete population." });
  if (value.status !== "completed" && value.score !== null) context.addIssue({ code: "custom", path: ["score"], message: "Only completed evaluations publish a metric value." });
  if (["completed", "failed", "cancelled"].includes(value.status) && (!value.completedAt || value.counts.pending || value.counts.running)) context.addIssue({ code: "custom", message: "Terminal runs require complete population accounting." });
  if (value.status === "cancelled" && !value.cleanupComplete) context.addIssue({ code: "custom", message: "Cancelled runs require confirmed cleanup." });
  if (value.resultAvailable && !["completed", "failed", "cancelled"].includes(value.status)) context.addIssue({ code: "custom", message: "Run results require terminal population accounting." });
  if (value.status === "completed" && (!value.cleanupComplete || !value.resultAvailable)) context.addIssue({ code: "custom", message: "Completed evaluations require retained results and confirmed cleanup." });
});
export type ModelTasksetRunSummary = z.infer<typeof ModelTasksetRunSummarySchema>;
export const ModelTasksetRunDetailsSchema = z.object({
  summary: ModelTasksetRunSummarySchema,
  request: ModelTasksetRunRequestSchema,
  manifest: TasksetRunManifestSchema,
  policySnapshot: ModelStarterAttemptSummarySchema.shape.policySnapshot,
}).strict();
export type ModelTasksetRunDetails = z.infer<typeof ModelTasksetRunDetailsSchema>;
export const ModelTasksetRunListQuerySchema = z.object({ modelProjectId: IdSchema, afterId: IdSchema.optional(), limit: z.number().int().min(1).max(100).default(25) }).strict();
export const ModelTasksetRunPageSchema = z.object({ items: z.array(ModelTasksetRunSummarySchema).max(100), nextCursor: IdSchema.nullable() }).strict();
export const ModelTasksetRunResultSchema = z.object({
  schemaVersion: z.literal("openpond.modelTasksetRunResult.v1"),
  run: ModelTasksetRunDetailsSchema,
  receipts: z.array(AttemptReceiptSchema).min(1).max(10_000),
  metric: TasksetMetricResultSchema.nullable(),
  contentHash: HashSchema,
}).strict();
export type ModelTasksetRunResult = z.infer<typeof ModelTasksetRunResultSchema>;

/** Server artifact ownership authenticates the producer. These checks bind all
 * portable projections to the admitted request, population and policy. */
export async function verifyModelTasksetRunDetails(value: unknown): Promise<ModelTasksetRunDetails> {
  const result = ModelTasksetRunDetailsSchema.parse(value);
  const { summary, request, manifest, policySnapshot } = result;
  assertContentHash(manifest, "Taskset run manifest");
  if (manifest.contentHash !== summary.manifestHash
    || manifest.id !== summary.id || manifest.createdAt !== summary.createdAt || summary.teamId !== request.teamId || summary.modelProjectId !== request.modelProjectId
    || summary.operationId !== request.operationId || summary.policyKind !== request.policy.kind
    || summary.totalCount !== request.population.length || summary.metricName !== manifest.metricPolicy.primaryMetric
    || canonicalJson(summary.taskset) !== canonicalJson(request.taskset)
    || manifest.tasksetRelease.id !== request.taskset.id || manifest.tasksetRelease.contentHash !== request.taskset.contentHash
    || canonicalJson(manifest.population) !== canonicalJson(request.population)) throw new Error("Evaluation run differs from its admitted request or manifest.");
  if (request.policy.kind === "fixture") {
    if (manifest.policy.kind !== "fixture" || policySnapshot !== null) throw new Error("Fixture checks cannot claim a model identity.");
  } else if (manifest.policy.kind !== "model" || !policySnapshot || policySnapshot.modelId !== request.policy.modelId
    || manifest.policy.model.provider !== policySnapshot.provider || manifest.policy.model.model !== policySnapshot.upstreamModelId
    || manifest.policy.model.revision !== null || manifest.policy.model.artifactHash !== null || manifest.policy.model.tokenizerRevision !== null || manifest.policy.model.chatTemplateHash !== null
    || manifest.policy.configurationHash !== await canonicalSha256({ policy: request.policy, snapshot: policySnapshot })) throw new Error("Evaluation model differs from its admitted policy.");
  return result;
}

export async function verifyModelTasksetRunResult(value: unknown): Promise<ModelTasksetRunResult> {
  const result = ModelTasksetRunResultSchema.parse(value);
  const { contentHash: actual, ...content } = result;
  if (await canonicalSha256(content) !== actual) throw new Error("Evaluation result integrity failed.");
  const { summary, manifest } = await verifyModelTasksetRunDetails(result.run);
  if (!summary.resultAvailable || !["completed", "failed", "cancelled"].includes(summary.status)) throw new Error("Evaluation result is not terminal.");
  const ordered = orderTasksetRunReceipts(manifest, result.receipts);
  if (canonicalJson(ordered) !== canonicalJson(result.receipts)) throw new Error("Evaluation receipts differ from the admitted order.");
  if ((summary.status === "completed") !== (result.metric !== null)) throw new Error("Only completed evaluations retain a metric.");
  if (result.metric) {
    assertTasksetMetricResult(result.metric);
    if (result.metric.runManifest.id !== manifest.id || result.metric.runManifest.contentHash !== manifest.contentHash
      || canonicalJson(result.metric.tasksetRelease) !== canonicalJson(manifest.tasksetRelease)
      || canonicalJson(result.metric.policy) !== canonicalJson(manifest.metricPolicy)
      || canonicalJson(result.metric.receiptRefs) !== canonicalJson(result.receipts.map(({ id, contentHash }) => ({ id, contentHash })))
      || result.metric.value !== summary.score) throw new Error("Evaluation metric differs from its admitted run or receipt population.");
  }
  return result;
}
