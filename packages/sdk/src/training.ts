import { z } from "zod";

import {
  ModelProjectBaseModelSchema,
  ModelProjectImmutableRefSchema,
  ModelProjectRecipeDocumentSchema,
  ModelProjectVersionedRefSchema,
} from "./model-projects.js";

const IdSchema = z.string().trim().min(1).max(500);
const HashSchema = z.string().regex(/^[a-f0-9]{64}$/);
const TimestampSchema = z.string().datetime({ offset: true });

export const TrainingJobKindSchema = z.enum([
  "reward_model_train",
  "policy_optimize",
]);

export const TrainingJobStateSchema = z.enum([
  "queued",
  "admitting",
  "provisioning",
  "running",
  "stopping",
  "cancelling",
  "succeeded",
  "failed",
  "cancelled",
]);

export const TrainingCapabilityRequirementSchema = z
  .object({
    id: IdSchema,
    version: z.string().trim().min(1).max(200).nullable().default(null),
    required: z.boolean().default(true),
  })
  .strict();

export const TrainingJobSourceSchema = z
  .object({
    modelProject: z
      .object({
        id: IdSchema,
        portableProjectId: IdSchema,
        revision: z.number().int().positive(),
        contentHash: HashSchema,
      })
      .strict(),
    harnessRunManifest: ModelProjectImmutableRefSchema,
    harnessRelease: ModelProjectImmutableRefSchema,
    taskset: ModelProjectVersionedRefSchema,
    tasksetRelease: ModelProjectImmutableRefSchema,
    dataset: ModelProjectImmutableRefSchema,
    evidenceSets: z.array(ModelProjectImmutableRefSchema).max(10_000),
  })
  .strict();

export const RewardModelTrainingRequestSchema = z
  .object({
    kind: z.literal("reward_model_train"),
    baseModel: ModelProjectBaseModelSchema,
    preferenceDatasetRelease: ModelProjectImmutableRefSchema,
    processorRelease: ModelProjectImmutableRefSchema,
    recipe: z
      .object({
        schemaVersion: z.literal("openpond.rewardModelRecipe.v1"),
        method: z.literal("reward_model"),
        parameterization: z.literal("lora_with_scalar_head"),
      })
      .catchall(z.unknown()),
  })
  .strict();

const DeterministicRewardSourceSchema = z
  .object({
    kind: z.literal("deterministic"),
    grader: ModelProjectImmutableRefSchema,
    composer: ModelProjectImmutableRefSchema.nullable().default(null),
  })
  .strict();

const LearnedRewardSourceSchema = z
  .object({
    kind: z.literal("learned_reward"),
    rewardModelVersion: ModelProjectImmutableRefSchema,
    qualificationReport: ModelProjectImmutableRefSchema.nullable(),
    scorerArtifact: z
      .object({
        artifactRef: z.string().trim().min(1).max(2_000),
        contentHash: HashSchema,
        executionReceipt: ModelProjectImmutableRefSchema,
      })
      .strict(),
    processorRelease: ModelProjectImmutableRefSchema,
    rewardComposerRelease: ModelProjectImmutableRefSchema,
  })
  .strict();

export const PolicyOptimizationRequestSchema = z
  .object({
    kind: z.literal("policy_optimize"),
    baseModel: ModelProjectBaseModelSchema,
    recipe: ModelProjectRecipeDocumentSchema,
    rewardSource: z.discriminatedUnion("kind", [
      DeterministicRewardSourceSchema,
      LearnedRewardSourceSchema,
    ]),
    resumeFrom: ModelProjectImmutableRefSchema.nullable().default(null),
  })
  .strict();

export const TrainingJobRequestSchema = z.discriminatedUnion("kind", [
  RewardModelTrainingRequestSchema,
  PolicyOptimizationRequestSchema,
]);

export const TrainingJobApprovalSchema = z
  .object({
    approvalHash: HashSchema,
    approvedAt: TimestampSchema,
    exportApproved: z.boolean(),
    maximumSpendUsd: z.number().nonnegative(),
    retentionDays: z.number().int().nonnegative().nullable(),
    region: z.string().trim().min(1).max(200).nullable().default(null),
  })
  .strict();

export const TrainingJobSubmissionSchema = z
  .object({
    schemaVersion: z.literal("openpond.trainingJobSubmission.v2"),
    idempotencyKey: z.string().trim().min(1).max(500),
    name: z.string().trim().min(1).max(200),
    source: TrainingJobSourceSchema,
    job: TrainingJobRequestSchema,
    requestedCapabilities: z
      .array(TrainingCapabilityRequirementSchema)
      .max(1_000),
    budget: z
      .object({
        maximumSpendUsd: z.number().nonnegative(),
        maximumWallSeconds: z.number().int().positive(),
      })
      .strict(),
    approval: TrainingJobApprovalSchema,
    contentHash: HashSchema,
  })
  .strict()
  .superRefine((submission, context) => {
    if (submission.approval.maximumSpendUsd !== submission.budget.maximumSpendUsd) {
      context.addIssue({
        code: "custom",
        path: ["approval", "maximumSpendUsd"],
        message: "Approved spend must equal the immutable Job budget.",
      });
    }
  });

export const TrainingJobSchema = z
  .object({
    schemaVersion: z.literal("openpond.trainingJob.v2"),
    id: IdSchema,
    teamId: IdSchema,
    kind: TrainingJobKindSchema,
    modelProjectId: IdSchema,
    portableProjectId: IdSchema,
    sourceProjectRevision: z.number().int().positive(),
    submissionHash: HashSchema,
    state: TrainingJobStateSchema,
    phase: z.string().trim().min(1).max(200),
    version: z.number().int().nonnegative(),
    progress: z.number().min(0).max(1),
    accruedSpendUsd: z.number().nonnegative(),
    terminalReason: z.string().trim().min(1).max(5_000).nullable(),
    createdAt: TimestampSchema,
    updatedAt: TimestampSchema,
    completedAt: TimestampSchema.nullable(),
  })
  .strict();

export const TrainingJobEventSchema = z
  .object({
    schemaVersion: z.literal("openpond.trainingJobEvent.v2"),
    id: IdSchema,
    jobId: IdSchema,
    sequence: z.number().int().nonnegative(),
    type: IdSchema,
    phase: z.string().trim().min(1).max(200),
    message: z.string().trim().min(1).max(5_000).nullable(),
    data: z.record(z.string(), z.unknown()).default({}),
    createdAt: TimestampSchema,
  })
  .strict();

export const TrainingJobLogSchema = z
  .object({
    schemaVersion: z.literal("openpond.trainingJobLog.v2"),
    jobId: IdSchema,
    sequence: z.number().int().nonnegative(),
    level: z.enum(["debug", "info", "warning", "error"]),
    message: z.string().max(20_000),
    createdAt: TimestampSchema,
  })
  .strict();

export const TrainingJobOutputSchema = z
  .object({
    schemaVersion: z.literal("openpond.trainingJobOutput.v2"),
    id: IdSchema,
    jobId: IdSchema,
    kind: z.enum([
      "checkpoint",
      "adapter",
      "scorer",
      "metrics",
      "evaluation",
      "trace",
      "receipt",
    ]),
    artifactRef: z.string().trim().min(1).max(2_000),
    contentHash: HashSchema,
    sizeBytes: z.number().int().nonnegative(),
    createdAt: TimestampSchema,
  })
  .strict();

export const TrainingExecutionReceiptSchema = z
  .object({
    schemaVersion: z.literal("openpond.trainingExecutionReceipt.v2"),
    id: IdSchema,
    teamId: IdSchema,
    jobId: IdSchema,
    submissionHash: HashSchema,
    manifestHash: HashSchema,
    recipeHash: HashSchema,
    capabilityHash: HashSchema,
    runtimeRelease: ModelProjectImmutableRefSchema,
    inputs: z.array(ModelProjectImmutableRefSchema).max(10_000),
    outputs: z.array(ModelProjectImmutableRefSchema).max(10_000),
    spendUsd: z.number().nonnegative(),
    durationSeconds: z.number().nonnegative(),
    cleanupComplete: z.boolean(),
    issuer: IdSchema,
    issuedAt: TimestampSchema,
    signature: z.string().trim().min(1).max(10_000).nullable(),
  })
  .strict();

export const TrainingCapabilitiesSchema = z
  .object({
    schemaVersion: z.literal("openpond.trainingCapabilities.v2"),
    capabilityHash: HashSchema,
    jobKinds: z.array(TrainingJobKindSchema),
    methods: z.array(z.string().trim().min(1).max(200)),
    placements: z.array(
      z.enum(["local", "remote", "colocated", "provider_native"]),
    ),
    controls: z
      .object({
        cancel: z.boolean(),
        stopAfterGroup: z.boolean(),
        resumeFromCheckpoint: z.boolean(),
      })
      .strict(),
    limits: z
      .object({
        maximumSpendUsd: z.number().nonnegative(),
        maximumWallSeconds: z.number().int().positive(),
        maximumArtifactBytes: z.number().int().positive(),
      })
      .strict(),
    checkedAt: TimestampSchema,
    expiresAt: TimestampSchema,
  })
  .strict();

export type TrainingJobSubmission = z.infer<
  typeof TrainingJobSubmissionSchema
>;
export type TrainingJob = z.infer<typeof TrainingJobSchema>;
export type TrainingJobEvent = z.infer<typeof TrainingJobEventSchema>;
export type TrainingJobOutput = z.infer<typeof TrainingJobOutputSchema>;
export type TrainingCapabilities = z.infer<typeof TrainingCapabilitiesSchema>;

function headersRecord(headers: HeadersInit | undefined): Record<string, string> {
  const result: Record<string, string> = {};
  new Headers(headers).forEach((value, key) => {
    result[key] = value;
  });
  return result;
}

export function createTrainingClient(input: {
  baseUrl: string;
  fetch?: typeof fetch;
  headers?: HeadersInit | (() => HeadersInit | Promise<HeadersInit>);
}) {
  const fetchImpl = input.fetch ?? fetch;
  const baseUrl = input.baseUrl.replace(/\/$/, "");

  async function request(pathname: string, init?: RequestInit): Promise<unknown> {
    const configuredHeaders =
      typeof input.headers === "function"
        ? await input.headers()
        : (input.headers ?? {});
    const response = await fetchImpl(`${baseUrl}${pathname}`, {
      ...init,
      headers: {
        accept: "application/json",
        ...(init?.body ? { "content-type": "application/json" } : {}),
        ...headersRecord(configuredHeaders),
        ...headersRecord(init?.headers),
      },
    });
    const body = (await response.json()) as unknown;
    if (!response.ok) throw new Error(errorMessage(body, response.status));
    return body;
  }

  return {
    async capabilities() {
      return TrainingCapabilitiesSchema.parse(
        unwrapObject(await request("/v1/training/capabilities"), "capabilities"),
      );
    },
    async createJob(submission: TrainingJobSubmission) {
      const parsed = TrainingJobSubmissionSchema.parse(submission);
      return TrainingJobSchema.parse(
        unwrapObject(
          await request("/v1/training/jobs", {
            method: "POST",
            body: JSON.stringify(parsed),
          }),
          "job",
        ),
      );
    },
    async listJobs(modelProjectId?: string) {
      const query = modelProjectId
        ? `?modelProjectId=${encodeURIComponent(IdSchema.parse(modelProjectId))}`
        : "";
      return z
        .array(TrainingJobSchema)
        .parse(unwrapObject(await request(`/v1/training/jobs${query}`), "jobs"));
    },
    async getJob(jobId: string) {
      return TrainingJobSchema.parse(
        unwrapObject(
          await request(`/v1/training/jobs/${encodeURIComponent(IdSchema.parse(jobId))}`),
          "job",
        ),
      );
    },
    async cancelJob(jobId: string) {
      return TrainingJobSchema.parse(
        unwrapObject(
          await request(
            `/v1/training/jobs/${encodeURIComponent(IdSchema.parse(jobId))}/cancel`,
            { method: "POST" },
          ),
          "job",
        ),
      );
    },
    async events(jobId: string) {
      return z
        .array(TrainingJobEventSchema)
        .parse(
          unwrapObject(
            await request(
              `/v1/training/jobs/${encodeURIComponent(IdSchema.parse(jobId))}/events`,
            ),
            "events",
          ),
        );
    },
    async outputs(jobId: string) {
      return z
        .array(TrainingJobOutputSchema)
        .parse(
          unwrapObject(
            await request(
              `/v1/training/jobs/${encodeURIComponent(IdSchema.parse(jobId))}/outputs`,
            ),
            "outputs",
          ),
        );
    },
  };
}

function unwrapObject(value: unknown, key: string): unknown {
  if (!value || typeof value !== "object" || Array.isArray(value)) return value;
  return key in value ? (value as Record<string, unknown>)[key] : value;
}

function errorMessage(value: unknown, status: number): string {
  if (value && typeof value === "object" && "error" in value) {
    return String((value as { error: unknown }).error);
  }
  return `Training request failed with HTTP ${status}.`;
}
