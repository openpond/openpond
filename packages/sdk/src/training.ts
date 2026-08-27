import { z } from "zod";

import {
  ModelProjectBaseModelSchema,
  ModelProjectImmutableRefSchema,
  ModelProjectRecipeDocumentSchema,
  ModelProjectVersionedRefSchema,
} from "./model-projects.js";
import {
  OPENPOND_TRAINING_MEDIA_TYPE,
  TRAINING_API_RESPONSE_MAX_BYTES,
  TRAINING_INPUT_ARTIFACT_MAX_BYTES,
  TRAINING_JOB_SUBMISSION_MAX_BYTES,
  OpenPondProtocolError,
  assertCanonicalPayloadSize,
  canonicalSha256,
  parseBoundedJson,
} from "./protocol.js";

export {
  OPENPOND_TRAINING_MEDIA_TYPE,
  OPENPOND_TRAINING_PROTOCOL_MAJOR,
  TRAINING_API_RESPONSE_MAX_BYTES,
  TRAINING_INPUT_ARTIFACT_MAX_BYTES,
  TRAINING_JOB_SUBMISSION_MAX_BYTES,
  OpenPondProtocolError,
  assertCanonicalPayloadSize,
  canonicalJson,
  canonicalJsonByteLength,
  canonicalSha256,
  parseBoundedJson,
} from "./protocol.js";

const IdSchema = z.string().trim().min(1).max(500);
const HashSchema = z.string().regex(/^[a-f0-9]{64}$/);
const TimestampSchema = z.string().datetime({ offset: true });

/**
 * Stages a content-addressed immutable input before Job admission. The payload
 * is deliberately opaque to the transport contract: its declared kind owns
 * the executable schema, while the envelope provides bounded bytes,
 * idempotency, and a stable manifest lookup key.
 */
export const TrainingInputArtifactUploadSchema = z
  .object({
    schemaVersion: z.literal("openpond.trainingInputArtifactUpload.v2"),
    kind: z.enum(["portable_training_bundle", "reward_model_dataset"]),
    idempotencyKey: z.string().trim().min(1).max(500),
    sourceManifest: ModelProjectImmutableRefSchema,
    payload: z.unknown(),
    contentHash: HashSchema,
  })
  .strict();

export const TrainingInputArtifactSchema = z
  .object({
    schemaVersion: z.literal("openpond.trainingInputArtifact.v2"),
    kind: z.enum(["portable_training_bundle", "reward_model_dataset"]),
    sourceManifest: ModelProjectImmutableRefSchema,
    artifactRef: z.string().trim().min(1).max(2_000),
    contentHash: HashSchema,
    sizeBytes: z.number().int().positive(),
    createdAt: TimestampSchema,
  })
  .strict();

export async function trainingInputArtifactUploadHash(
  upload: Omit<TrainingInputArtifactUpload, "contentHash"> | TrainingInputArtifactUpload,
): Promise<string> {
  const { contentHash: _contentHash, ...content } = upload as TrainingInputArtifactUpload;
  return canonicalSha256(content);
}

export async function parseAndVerifyTrainingInputArtifactUpload(
  value: unknown,
): Promise<TrainingInputArtifactUpload> {
  assertCanonicalPayloadSize(
    value,
    TRAINING_INPUT_ARTIFACT_MAX_BYTES,
    "Training input artifact",
  );
  const parsed = TrainingInputArtifactUploadSchema.parse(value);
  const expectedHash = await trainingInputArtifactUploadHash(parsed);
  if (parsed.contentHash !== expectedHash) {
    throw new OpenPondProtocolError(
      "content_hash_mismatch",
      `Training input artifact contentHash ${parsed.contentHash} does not match ${expectedHash}.`,
    );
  }
  return parsed;
}

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

export async function trainingJobSubmissionHash(
  submission: Omit<TrainingJobSubmission, "contentHash"> | TrainingJobSubmission,
): Promise<string> {
  const { contentHash: _contentHash, ...content } = submission as TrainingJobSubmission;
  return canonicalSha256(content);
}

export async function parseAndVerifyTrainingJobSubmission(
  value: unknown,
): Promise<TrainingJobSubmission> {
  assertCanonicalPayloadSize(
    value,
    TRAINING_JOB_SUBMISSION_MAX_BYTES,
    "Training Job submission",
  );
  const parsed = TrainingJobSubmissionSchema.parse(value);
  const expectedHash = await trainingJobSubmissionHash(parsed);
  if (parsed.contentHash !== expectedHash) {
    throw new OpenPondProtocolError(
      "content_hash_mismatch",
      `Training Job contentHash ${parsed.contentHash} does not match ${expectedHash}.`,
    );
  }
  return parsed;
}

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

export const TrainingJobPageSchema = z
  .object({
    schemaVersion: z.literal("openpond.trainingJobPage.v2"),
    jobs: z.array(TrainingJobSchema).max(1_000),
    nextCursor: z.string().trim().min(1).max(2_000).nullable(),
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

export const TrainingJobControlRequestSchema = z
  .object({ expectedVersion: z.number().int().nonnegative() })
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
    metadata: z.record(z.string(), z.unknown()).default({}),
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

export async function trainingExecutionReceiptHash(
  receipt: TrainingExecutionReceipt,
): Promise<string> {
  return canonicalSha256(TrainingExecutionReceiptSchema.parse(receipt));
}

export async function parseAndVerifyTrainingExecutionReceipt(
  value: unknown,
  expected: {
    id: string;
    contentHash: string;
    teamId?: string;
    jobId?: string;
    requireCleanup?: boolean;
  },
): Promise<TrainingExecutionReceipt> {
  const receipt = TrainingExecutionReceiptSchema.parse(value);
  const expectedId = IdSchema.parse(expected.id);
  const expectedHash = HashSchema.parse(expected.contentHash);
  const actualHash = await trainingExecutionReceiptHash(receipt);
  if (receipt.id !== expectedId || actualHash !== expectedHash) {
    throw new OpenPondProtocolError(
      "execution_receipt_mismatch",
      "The execution receipt identity or canonical content hash did not match.",
    );
  }
  if (expected.teamId !== undefined && receipt.teamId !== IdSchema.parse(expected.teamId)) {
    throw new OpenPondProtocolError(
      "execution_receipt_team_mismatch",
      "The execution receipt belongs to a different team.",
    );
  }
  if (expected.jobId !== undefined && receipt.jobId !== IdSchema.parse(expected.jobId)) {
    throw new OpenPondProtocolError(
      "execution_receipt_job_mismatch",
      "The execution receipt belongs to a different Training Job.",
    );
  }
  if ((expected.requireCleanup ?? true) && !receipt.cleanupComplete) {
    throw new OpenPondProtocolError(
      "execution_cleanup_incomplete",
      "The execution receipt does not attest complete terminal cleanup.",
    );
  }
  return receipt;
}

export const TrainingJobOutputsSchema = z
  .object({
    schemaVersion: z.literal("openpond.trainingJobOutputs.v2"),
    outputs: z.array(TrainingJobOutputSchema).max(10_000),
    receipt: TrainingExecutionReceiptSchema.nullable(),
  })
  .strict();

export const TrainingApiErrorSchema = z
  .object({
    schemaVersion: z.literal("openpond.trainingApiError.v2"),
    code: z.string().trim().min(1).max(200),
    message: z.string().trim().min(1).max(5_000),
    retryable: z.boolean().default(false),
    requestId: z.string().trim().min(1).max(500).nullable().default(null),
    details: z.record(z.string(), z.unknown()).default({}),
  })
  .strict();

export class OpenPondTrainingApiError extends Error {
  readonly status: number;
  readonly code: string;
  readonly retryable: boolean;
  readonly requestId: string | null;
  readonly details: Record<string, unknown>;

  constructor(status: number, error: z.infer<typeof TrainingApiErrorSchema>) {
    super(error.message);
    this.name = "OpenPondTrainingApiError";
    this.status = status;
    this.code = error.code;
    this.retryable = error.retryable;
    this.requestId = error.requestId;
    this.details = error.details;
  }
}

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
export type TrainingInputArtifactUpload = z.infer<
  typeof TrainingInputArtifactUploadSchema
>;
export type TrainingInputArtifact = z.infer<typeof TrainingInputArtifactSchema>;
export type TrainingJob = z.infer<typeof TrainingJobSchema>;
export type TrainingJobPage = z.infer<typeof TrainingJobPageSchema>;
export type TrainingJobEvent = z.infer<typeof TrainingJobEventSchema>;
export type TrainingJobLog = z.infer<typeof TrainingJobLogSchema>;
export type TrainingJobOutput = z.infer<typeof TrainingJobOutputSchema>;
export type TrainingJobOutputs = z.infer<typeof TrainingJobOutputsSchema>;
export type TrainingExecutionReceipt = z.infer<
  typeof TrainingExecutionReceiptSchema
>;
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
        accept: OPENPOND_TRAINING_MEDIA_TYPE,
        ...(init?.body ? { "content-type": OPENPOND_TRAINING_MEDIA_TYPE } : {}),
        ...headersRecord(configuredHeaders),
        ...headersRecord(init?.headers),
      },
    });
    const body = parseBoundedJson(
      await response.text(),
      TRAINING_API_RESPONSE_MAX_BYTES,
      "Training API response",
    );
    if (!response.ok) throw trainingApiError(body, response.status);
    return body;
  }

  return {
    async capabilities() {
      return TrainingCapabilitiesSchema.parse(
        unwrapObject(await request("/v1/training/capabilities"), "capabilities"),
      );
    },
    async stageArtifact(upload: TrainingInputArtifactUpload) {
      const parsed = await parseAndVerifyTrainingInputArtifactUpload(upload);
      return TrainingInputArtifactSchema.parse(
        unwrapObject(
          await request("/v1/training/artifacts", {
            method: "POST",
            body: JSON.stringify(parsed),
          }),
          "artifact",
        ),
      );
    },
    async createJob(submission: TrainingJobSubmission) {
      const parsed = await parseAndVerifyTrainingJobSubmission(submission);
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
    async listJobs(options: {
      modelProjectId?: string;
      cursor?: string;
      limit?: number;
    } = {}) {
      const parameters = new URLSearchParams();
      if (options.modelProjectId) {
        parameters.set("modelProjectId", IdSchema.parse(options.modelProjectId));
      }
      if (options.cursor) {
        parameters.set("cursor", z.string().trim().min(1).max(2_000).parse(options.cursor));
      }
      if (options.limit !== undefined) {
        parameters.set(
          "limit",
          String(z.number().int().min(1).max(1_000).parse(options.limit)),
        );
      }
      const query = parameters.size > 0 ? `?${parameters.toString()}` : "";
      return TrainingJobPageSchema.parse(
        await request(`/v1/training/jobs${query}`),
      );
    },
    async getJob(jobId: string) {
      return TrainingJobSchema.parse(
        unwrapObject(
          await request(`/v1/training/jobs/${encodeURIComponent(IdSchema.parse(jobId))}`),
          "job",
        ),
      );
    },
    async cancelJob(jobId: string, expectedVersion: number) {
      const control = TrainingJobControlRequestSchema.parse({ expectedVersion });
      return TrainingJobSchema.parse(
        unwrapObject(
          await request(
            `/v1/training/jobs/${encodeURIComponent(IdSchema.parse(jobId))}/cancel`,
            { method: "POST", body: JSON.stringify(control) },
          ),
          "job",
        ),
      );
    },
    async stopAfterGroup(jobId: string, expectedVersion: number) {
      const control = TrainingJobControlRequestSchema.parse({ expectedVersion });
      return TrainingJobSchema.parse(
        unwrapObject(
          await request(
            `/v1/training/jobs/${encodeURIComponent(IdSchema.parse(jobId))}/stop-after-group`,
            { method: "POST", body: JSON.stringify(control) },
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
      return TrainingJobOutputsSchema.parse(
        await request(
          `/v1/training/jobs/${encodeURIComponent(IdSchema.parse(jobId))}/outputs`,
        ),
      );
    },
    async logs(jobId: string) {
      return z.array(TrainingJobLogSchema).max(100_000).parse(
        unwrapObject(
          await request(
            `/v1/training/jobs/${encodeURIComponent(IdSchema.parse(jobId))}/logs`,
          ),
          "logs",
        ),
      );
    },
  };
}

function unwrapObject(value: unknown, key: string): unknown {
  if (!value || typeof value !== "object" || Array.isArray(value)) return value;
  return key in value ? (value as Record<string, unknown>)[key] : value;
}

function trainingApiError(value: unknown, status: number): Error {
  const parsed = TrainingApiErrorSchema.safeParse(value);
  if (parsed.success) {
    return new OpenPondTrainingApiError(status, parsed.data);
  }
  return new OpenPondProtocolError(
    "invalid_error_response",
    `Training request failed with HTTP ${status} and an invalid error envelope.`,
  );
}
