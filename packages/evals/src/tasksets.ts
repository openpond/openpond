import { z } from "zod";

import {
  ImmutableAssetRefSchema,
  ImmutableReleaseRefSchema,
  MetadataSchema,
  ReleaseHashSchema,
  ReleaseIdSchema,
  assertContentHash,
  contentHash,
} from "./common.js";

export const TaskSplitSchema = z.enum(["train", "validation", "test", "frozen_eval"]);
export const PolicyBoundarySchema = z.object({
  policyVisibleFields: z.array(ReleaseIdSchema).max(1_000).default([]),
  privilegedFields: z.array(ReleaseIdSchema).max(1_000).default([]),
  hiddenGraderRefs: z.array(ReleaseIdSchema).max(1_000).default([]),
  connectedAppScopes: z.array(ReleaseIdSchema).max(100).default([]),
}).strict();

export const ToolDeclarationSchema = z.object({
  name: z.string().trim().min(1).max(64).regex(/^[a-zA-Z][a-zA-Z0-9_-]*$/),
  description: z.string().trim().min(1).max(2_000),
  inputSchema: z.record(z.string(), z.unknown()),
  inputSchemaHash: ReleaseHashSchema,
  sideEffect: z.enum(["read", "write"]),
  timeoutMs: z.number().int().positive().max(3_600_000),
}).strict();

export const CapabilityRequirementSchema = z.object({
  id: ReleaseIdSchema,
  required: z.boolean(),
  scopes: z.array(z.string().trim().min(1).max(500)).max(100).default([]),
  portability: z.enum(["portable", "host_adapter", "local_only", "hosted_only"]),
}).strict();

export const EnvironmentContractSchema = z.object({
  protocolVersion: z.literal("openpond.environment.v1"),
  kind: z.enum(["text", "agent", "work", "custom_program"]),
  entrypoint: z.string().trim().min(1).max(1_000),
  stateful: z.boolean(),
  deterministicSeeds: z.boolean(),
  lifecycle: z.array(z.enum(["create", "reset", "step", "collect", "destroy"])).min(5).max(5),
  networkPolicy: z.enum(["none", "declared_read_only", "declared_scoped"]),
  defaultTimeoutMs: z.number().int().positive().max(3_600_000),
}).strict();

const GraderBaseSchema = z.object({
  id: ReleaseIdSchema,
  version: z.string().trim().min(1).max(100),
  weight: z.number().nonnegative().max(1_000).default(1),
  hardGate: z.boolean().default(false),
  rewardEligible: z.boolean().default(false),
  privileged: z.boolean().default(false),
});

export const DeterministicGraderSpecSchema = GraderBaseSchema.extend({
  kind: z.enum(["content", "schema", "artifact", "runtime_event", "state"]),
  config: z.record(z.string(), z.unknown()),
}).strict();
export const ModelJudgeGraderSpecSchema = GraderBaseSchema.extend({
  kind: z.literal("model_judge"),
  rubricRef: ImmutableAssetRefSchema,
  calibrationStatus: z.enum(["pending", "passed", "failed"]),
}).strict();
export const CustomVerifierGraderSpecSchema = GraderBaseSchema.extend({
  kind: z.literal("custom_verifier"),
  verifierRef: ImmutableAssetRefSchema,
  timeoutMs: z.number().int().positive().max(300_000),
  networkPolicy: z.literal("none"),
}).strict();
export const HumanGraderSpecSchema = GraderBaseSchema.extend({
  kind: z.literal("human"),
  rubricRef: ImmutableAssetRefSchema,
  reviewerRole: z.string().trim().min(1).max(500),
}).strict();
export const GraderSpecSchema = z.union([
  DeterministicGraderSpecSchema,
  ModelJudgeGraderSpecSchema,
  CustomVerifierGraderSpecSchema,
  HumanGraderSpecSchema,
]);

export const TaskRecordSchema = z.object({
  id: ReleaseIdSchema,
  clusterKey: ReleaseIdSchema,
  split: TaskSplitSchema,
  input: z.record(z.string(), z.unknown()),
  expectedOutput: z.record(z.string(), z.unknown()).nullable(),
  policyVisibleContext: z.record(z.string(), z.unknown()).default({}),
  privilegedContextRef: ReleaseIdSchema.nullable(),
  artifactRefs: z.array(ImmutableAssetRefSchema).max(1_000).default([]),
  tags: z.array(ReleaseIdSchema).max(100).default([]),
}).strict();

export const TasksetReleaseContentSchema = z.object({
  schemaVersion: z.literal("openpond.tasksetRelease.v1"),
  id: ReleaseIdSchema,
  revision: z.number().int().positive(),
  harnessRelease: ImmutableReleaseRefSchema,
  policy: PolicyBoundarySchema,
  environment: EnvironmentContractSchema,
  tools: z.array(ToolDeclarationSchema).max(200),
  capabilities: z.array(CapabilityRequirementSchema).max(200),
  tasks: z.array(TaskRecordSchema).min(1).max(1_000_000),
  graders: z.array(GraderSpecSchema).min(1).max(1_000),
  metadata: MetadataSchema,
}).strict();
export const TasksetReleaseSchema = TasksetReleaseContentSchema.extend({ contentHash: ReleaseHashSchema }).strict();

export type TasksetValidationIssue = {
  code: string;
  severity: "warning" | "error";
  message: string;
  path: string | null;
};

export function validateTasksetRelease(input: unknown): {
  valid: boolean;
  taskset: TasksetRelease | null;
  computedHash: string | null;
  issues: TasksetValidationIssue[];
} {
  const parsed = TasksetReleaseSchema.safeParse(input);
  if (!parsed.success) {
    return {
      valid: false,
      taskset: null,
      computedHash: null,
      issues: parsed.error.issues.map((issue) => ({
        code: "schema_invalid",
        severity: "error",
        message: issue.message,
        path: issue.path.join("."),
      })),
    };
  }
  const taskset = parsed.data;
  const issues: TasksetValidationIssue[] = [];
  const clusterSplits = new Map<string, Set<string>>();
  for (const task of taskset.tasks) {
    const splits = clusterSplits.get(task.clusterKey) ?? new Set<string>();
    splits.add(task.split);
    clusterSplits.set(task.clusterKey, splits);
  }
  for (const [cluster, splits] of clusterSplits) {
    if (splits.size > 1) issues.push({
      code: "split_cluster_contamination",
      severity: "error",
      message: `Source cluster ${cluster} appears in multiple splits.`,
      path: "tasks",
    });
  }
  if (!taskset.tasks.some((task) => task.split === "frozen_eval")) issues.push({
    code: "frozen_eval_missing",
    severity: "warning",
    message: "The release has no frozen-evaluation task.",
    path: "tasks",
  });
  const { contentHash: _contentHash, ...tasksetContent } = taskset;
  const computedHash = contentHash(TasksetReleaseContentSchema.parse(tasksetContent));
  if (computedHash !== taskset.contentHash) issues.push({
    code: "content_hash_mismatch",
    severity: "error",
    message: `Taskset contentHash is ${taskset.contentHash}; expected ${computedHash}.`,
    path: "contentHash",
  });
  return { valid: !issues.some((issue) => issue.severity === "error"), taskset, computedHash, issues };
}

export function assertTasksetRelease(taskset: TasksetRelease): void {
  assertContentHash(taskset, "Taskset release");
  const report = validateTasksetRelease(taskset);
  const error = report.issues.find((issue) => issue.severity === "error");
  if (error) throw new Error(error.message);
}

export function policyTaskView(task: TaskRecord): {
  id: string;
  input: Record<string, unknown>;
  policyVisibleContext: Record<string, unknown>;
  artifactRefs: Array<z.infer<typeof ImmutableAssetRefSchema>>;
  tags: string[];
} {
  return {
    id: task.id,
    input: structuredClone(task.input),
    policyVisibleContext: structuredClone(task.policyVisibleContext),
    artifactRefs: task.artifactRefs.filter((artifact) => artifact.visibility === "policy"),
    tags: [...task.tags],
  };
}

export function trainingPolicyTaskViews(taskset: TasksetRelease): ReturnType<typeof policyTaskView>[] {
  return taskset.tasks
    .filter((task) => task.split !== "frozen_eval")
    .map(policyTaskView);
}

export type ToolDeclaration = z.infer<typeof ToolDeclarationSchema>;
export type CapabilityRequirement = z.infer<typeof CapabilityRequirementSchema>;
export type EnvironmentContract = z.infer<typeof EnvironmentContractSchema>;
export type GraderSpec = z.infer<typeof GraderSpecSchema>;
export type DeterministicGraderSpec = z.infer<typeof DeterministicGraderSpecSchema>;
export type TaskRecord = z.infer<typeof TaskRecordSchema>;
export type TasksetRelease = z.infer<typeof TasksetReleaseSchema>;
