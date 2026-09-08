import { z } from "zod";
import { assertContentHash, contentHash, ImmutableReleaseRefSchema, MetadataSchema, ModelRefSchema, ReleaseHashSchema, ReleaseIdSchema, ReleaseTimestampSchema } from "@openpond/harness";
import { RunLimitsSchema, RuntimeTargetBindingSchema, verifyAttemptReceipt, type AttemptReceipt } from "./runs.js";
import { TasksetMetricPolicySchema, type TasksetMetricPolicy } from "./metric-policy.js";
import { assertTasksetRelease, type TasksetRelease } from "./tasksets.js";

/** A fixture check owns no model identity and cannot become a model evaluation. */
export const TasksetRunPolicySchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("model"), model: ModelRefSchema, configurationHash: ReleaseHashSchema }).strict(),
  z.object({ kind: z.literal("fixture") }).strict(),
]);
export const TasksetRunExecutionSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("taskset"), environmentRelease: ImmutableReleaseRefSchema, verifierSetRelease: ImmutableReleaseRefSchema, policyHash: ReleaseHashSchema }).strict(),
  z.object({ kind: z.literal("harness"), harnessRelease: ImmutableReleaseRefSchema }).strict(),
]);
export const TasksetRunMemberSchema = z.object({
  receiptId: ReleaseIdSchema,
  taskId: ReleaseIdSchema,
  seed: z.string().trim().min(1).max(500),
  fixtureId: ReleaseIdSchema.nullable(),
}).strict();

export const TasksetRunManifestContentSchema = z.object({
  schemaVersion: z.literal("openpond.tasksetRunManifest.v1"),
  id: ReleaseIdSchema,
  tasksetRelease: ImmutableReleaseRefSchema,
  packageHash: ReleaseHashSchema,
  execution: TasksetRunExecutionSchema,
  policy: TasksetRunPolicySchema,
  gradingRole: z.literal("evaluation"),
  metricPolicy: TasksetMetricPolicySchema,
  population: z.array(TasksetRunMemberSchema).min(1).max(100_000),
  runtimeTarget: RuntimeTargetBindingSchema,
  limits: RunLimitsSchema,
  createdAt: ReleaseTimestampSchema,
  metadata: MetadataSchema,
}).strict().superRefine((value, context) => {
  if (new Set(value.population.map(member => member.receiptId)).size !== value.population.length) context.addIssue({ code: "custom", path: ["population"], message: "Run receipt identities must be unique." });
  if (value.population.some(member => (member.fixtureId !== null) !== (value.policy.kind === "fixture"))) context.addIssue({ code: "custom", path: ["population"], message: "Only fixture runs require a fixture identity for every member." });
});
export const TasksetRunManifestSchema = TasksetRunManifestContentSchema.safeExtend({ contentHash: ReleaseHashSchema });
export type TasksetRunManifest = z.infer<typeof TasksetRunManifestSchema>;

export function createTasksetRunManifest(input: z.input<typeof TasksetRunManifestContentSchema>): TasksetRunManifest {
  const content = TasksetRunManifestContentSchema.parse(input);
  return TasksetRunManifestSchema.parse({ ...content, contentHash: contentHash(content) });
}

export function tasksetRunMetricPolicy(taskset: TasksetRelease): TasksetMetricPolicy {
  return taskset.metrics ?? {
    schemaVersion: "openpond.tasksetMetricPolicy.v1", primaryMetric: "mean_score",
    aggregation: "mean_score", missingReward: "exclude", customAggregator: null,
  };
}

/** Admission verifies this before dispatch. Package byte verification belongs
 * to the package loader; this validates the release and population semantics. */
export function assertTasksetRunRelease(manifest: TasksetRunManifest, taskset: TasksetRelease): void {
  TasksetRunManifestSchema.parse(manifest);
  assertContentHash(manifest, "Taskset run manifest");
  assertTasksetRelease(taskset);
  if (manifest.tasksetRelease.id !== taskset.id || manifest.tasksetRelease.contentHash !== taskset.contentHash) throw new Error("Taskset run differs from its pinned release.");
  if (contentHash(manifest.metricPolicy) !== contentHash(tasksetRunMetricPolicy(taskset))) throw new Error("Taskset run metric differs from its pinned release.");
  const tasks = new Set(taskset.tasks.map(task => task.id));
  if (manifest.population.some(member => !tasks.has(member.taskId))) throw new Error("Taskset run population contains an unknown task.");
  if (manifest.execution.kind === "taskset" && (
    !taskset.environmentRelease || !taskset.verifierSetRelease
    || contentHash(manifest.execution.environmentRelease) !== contentHash(taskset.environmentRelease)
    || contentHash(manifest.execution.verifierSetRelease) !== contentHash(taskset.verifierSetRelease)
    || manifest.execution.policyHash !== contentHash(taskset.policy)
  )) throw new Error("Taskset-owned execution differs from its pinned release.");
}

/** Complete runs cannot drop failed members, add convenient attempts or relabel
 * another task/seed's evidence. Ordering is always the admitted population's. */
export function orderTasksetRunReceipts(manifest: TasksetRunManifest, receipts: AttemptReceipt[]): AttemptReceipt[] {
  TasksetRunManifestSchema.parse(manifest);
  assertContentHash(manifest, "Taskset run manifest");
  const byId = new Map(receipts.map(receipt => [receipt.id, receipt]));
  if (byId.size !== receipts.length || receipts.length !== manifest.population.length) throw new Error("Run receipts differ from the complete admitted population.");
  return manifest.population.map(member => {
    const receipt = byId.get(member.receiptId);
    if (!receipt || !verifyAttemptReceipt(receipt)
      || receipt.runManifest.id !== manifest.id || receipt.runManifest.contentHash !== manifest.contentHash
      || receipt.taskId !== member.taskId || receipt.seed !== member.seed) throw new Error("Run receipt differs from its admitted member or manifest.");
    if (receipt.metadata.gradingRole !== "evaluation") throw new Error("Taskset run requires evaluation-role evidence.");
    if (!receipt.terminal && !["infrastructure_failure", "timeout", "cancelled"].includes(receipt.failureClass ?? "")) throw new Error("Taskset run member has no terminal accounting outcome.");
    return receipt;
  });
}
