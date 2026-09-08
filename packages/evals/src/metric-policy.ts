import { z } from "zod";
import { assertContentHash, contentHash, ImmutableReleaseRefSchema, ReleaseHashSchema } from "@openpond/harness";

const MetricIdSchema = z.string().trim().min(1).max(240);
const ModulePathSchema = z.string().trim().min(1).max(1_000).refine((value) =>
  !/[\\:\0]/.test(value) && value.split("/").every((part) => part && part !== "." && part !== ".." && !part.startsWith(".env")),
"Metric modules must use a safe relative path.");

export const TasksetMetricPolicySchema = z.object({
  schemaVersion: z.literal("openpond.tasksetMetricPolicy.v1"),
  primaryMetric: MetricIdSchema,
  aggregation: z.enum(["mean_score", "pass_rate", "weighted_mean", "custom"]),
  missingReward: z.enum(["zero", "exclude"]),
  taskWeights: z.record(MetricIdSchema, z.number().positive().max(1_000_000)).optional(),
  customAggregator: z.object({
    module: ModulePathSchema,
    exportName: z.string().trim().regex(/^[A-Za-z_$][A-Za-z0-9_$]*$/),
    contentHash: ReleaseHashSchema,
    timeoutMs: z.number().int().positive().max(300_000),
    networkPolicy: z.literal("none"),
  }).strict().nullable(),
}).strict().superRefine((policy, context) => {
  if ((policy.aggregation === "custom") !== (policy.customAggregator !== null)) {
    context.addIssue({ code: "custom", path: ["customAggregator"], message: "Only custom aggregation requires a content-hashed module." });
  }
  if (policy.aggregation === "weighted_mean" ? !policy.taskWeights || !Object.keys(policy.taskWeights).length : policy.taskWeights !== undefined) {
    context.addIssue({ code: "custom", path: ["taskWeights"], message: "Only weighted means require explicit positive task weights." });
  }
});

export const TasksetMetricResultContentSchema = z.object({
  schemaVersion: z.literal("openpond.tasksetMetricResult.v1"),
  runManifest: ImmutableReleaseRefSchema,
  tasksetRelease: ImmutableReleaseRefSchema,
  policy: TasksetMetricPolicySchema,
  policyHash: ReleaseHashSchema,
  receiptRefs: z.array(ImmutableReleaseRefSchema).min(1).max(1_000_000),
  includedCount: z.number().int().nonnegative(),
  missingRewardCount: z.number().int().nonnegative(),
  excludedCount: z.number().int().nonnegative(),
  value: z.number().min(0).max(1).nullable(),
}).strict();
export const TasksetMetricResultSchema = TasksetMetricResultContentSchema.extend({ contentHash: ReleaseHashSchema }).strict();
export type TasksetMetricPolicy = z.infer<typeof TasksetMetricPolicySchema>;
export type TasksetMetricResult = z.infer<typeof TasksetMetricResultSchema>;

export function assertTasksetMetricResult(input: TasksetMetricResult): void {
  const result = TasksetMetricResultSchema.parse(input);
  assertContentHash(result, "Taskset metric result");
  if (result.policyHash !== contentHash(result.policy)) throw new Error("Taskset metric policy hash differs from its policy.");
  if (result.includedCount + result.excludedCount !== result.receiptRefs.length
    || (result.includedCount === 0) !== (result.value === null)
    || result.missingRewardCount > (result.policy.missingReward === "zero" ? result.includedCount : result.excludedCount)
    || new Set(result.receiptRefs.map(ref => ref.id)).size !== result.receiptRefs.length) {
    throw new Error("Taskset metric population differs from its receipt references.");
  }
}
