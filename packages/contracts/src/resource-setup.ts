import { z } from "zod";
import { ExperimentGraderSelectionSchema } from "openpond-sdk/experiments";
import { TasksetCatalogReleaseRefSchema } from "openpond-sdk/taskset-catalog";
import { DatasetSplitSchema } from "openpond-sdk/taskset-drafts";
import { ModelProjectBaseModelSchema, ModelProjectRecipeDocumentSchema, ModelProjectVersionedRefSchema, RegisteredAdapterVersionSchema } from "openpond-sdk/model-projects";
import { SftRecipeSchema } from "openpond-sdk/training";

const fieldText = z.string().max(2_000).optional();
const positiveInteger = z.number().int().positive().optional();
const nonnegativeNumber = z.number().nonnegative().optional();
const artifactHash = z.string().regex(/^[a-f0-9]{64}$/);
const resourceId = z.string().min(1).max(240);
const LocalBenchmarkModelVersionSchema = z.object({
  location: z.literal("local"), projectId: resourceId, versionId: resourceId, artifactId: resourceId, bundleHash: artifactHash,
}).strict();
const HostedBenchmarkOwnerSchema = z.object({ actorId: resourceId, apiOrigin: z.url() }).strict();
const HostedBenchmarkVersionSchema = z.object({
  location: z.literal("cloud"), modelProjectId: resourceId, jobId: resourceId,
  teamId: resourceId, versionHash: artifactHash, owner: HostedBenchmarkOwnerSchema.optional(),
}).strict();
export const BenchmarkModelVersionSchema = z.discriminatedUnion("location", [
  LocalBenchmarkModelVersionSchema, HostedBenchmarkVersionSchema,
]);
const OwnedBenchmarkVersionSchema = HostedBenchmarkVersionSchema.extend({ owner: HostedBenchmarkOwnerSchema });
export const ManagedBenchmarkVersionsSchema = z.object({
  candidate: OwnedBenchmarkVersionSchema, baseline: OwnedBenchmarkVersionSchema.optional(),
}).strict().refine(({ candidate, baseline }) => !baseline || (
  candidate.teamId === baseline.teamId && candidate.owner.actorId === baseline.owner.actorId &&
  candidate.owner.apiOrigin === baseline.owner.apiOrigin && candidate.jobId !== baseline.jobId &&
  candidate.versionHash !== baseline.versionHash
), "Choose two distinct saved versions from the same workspace.");
export type ManagedBenchmarkVersions = z.infer<typeof ManagedBenchmarkVersionsSchema>;
export const ManagedBenchmarkDatasetSchema = z.object({
  teamId: resourceId,
  owner: HostedBenchmarkOwnerSchema,
  release: TasksetCatalogReleaseRefSchema,
  label: z.string().trim().min(1).max(500),
  graders: ExperimentGraderSelectionSchema.array().max(100).optional(),
}).strict();
export type ManagedBenchmarkDataset = z.infer<typeof ManagedBenchmarkDatasetSchema>;
const BenchmarkSamplingSchema = z.object({
  temperature: z.number().min(0).max(2).nullable(),
  topP: z.number().gt(0).max(1).nullable(),
}).strict();
const ManagedBenchmarkProtocolSchema = z.object({
  environmentSeeds: z.string().max(10_000).optional(),
  systemInstructions: z.string().max(100_000).optional(),
  sampling: BenchmarkSamplingSchema.nullable().optional(),
}).strict();
export type ManagedBenchmarkProtocol = z.infer<typeof ManagedBenchmarkProtocolSchema>;
export function parseEvaluationEnvironmentSeeds(text: string) {
  const seeds = [...new Set(text.split(/[\s,]+/).filter(Boolean))];
  if (!seeds.length || seeds.some(value => !/^(0|[1-9][0-9]*)$/.test(value) || Number(value) > 2_147_483_647))
    throw new Error("Enter integer environment seeds from 0 to 2147483647, separated by commas.");
  return seeds;
}

export const ManagedBenchmarkReviewSchema = z.object({
  expectedRevision: z.number().int().positive(),
  versions: ManagedBenchmarkVersionsSchema,
  name: z.string().trim().min(1).max(191).optional(),
  budget: z.number().min(0).max(10_000).optional(),
  seed: z.number().int().min(0).max(2_147_483_647).optional(),
  dataset: ManagedBenchmarkDatasetSchema.nullable().optional(),
  split: DatasetSplitSchema.optional(),
  samples: z.number().int().min(1).max(100).optional(),
  outputTokens: z.number().int().min(1).max(4096).optional(),
  protocol: ManagedBenchmarkProtocolSchema.optional(),
}).strict();
export type ManagedBenchmarkReview = z.infer<typeof ManagedBenchmarkReviewSchema>;
export type BenchmarkModelVersion = z.infer<typeof BenchmarkModelVersionSchema>;
type HostedBenchmarkVersion = Extract<BenchmarkModelVersion, { location: "cloud" }>;
export function ownsHostedBenchmarkVersion(
  version: Pick<HostedBenchmarkVersion, "teamId" | "owner">,
  scope: { teamId: string | null; actorId: string | null; apiOrigin?: string | null } | null | undefined,
) {
  return Boolean(version.owner && scope && version.teamId === scope.teamId &&
    version.owner.actorId === scope.actorId && version.owner.apiOrigin === scope.apiOrigin);
}
export const LocalAdapterPublicationRequestSchema = z.object({
  profileId: resourceId, teamId: resourceId, actorId: resourceId, version: LocalBenchmarkModelVersionSchema,
}).strict();
export const LocalAdapterPublicationScheduleSchema = LocalAdapterPublicationRequestSchema.extend({ reviewHash: artifactHash });
export const LocalAdapterPublicationStateSchema = z.discriminatedUnion("state", [
  z.object({ state: z.literal("review"), reviewHash: artifactHash, modelName: resourceId,
    hostedModelId: resourceId, baseRepository: resourceId, baseRevision: z.string(),
    bytes: z.number().int().positive(), localVersionHash: artifactHash, adapterSha256: artifactHash }).strict(),
  z.object({ state: z.literal("registered"), version: RegisteredAdapterVersionSchema }).strict(),
]);
export type LocalAdapterPublicationRequest = z.infer<typeof LocalAdapterPublicationRequestSchema>;
export type LocalAdapterPublicationState = z.infer<typeof LocalAdapterPublicationStateSchema>;
const localModelRef = z.object({
  modelId: z.string().min(1).max(500),
  configurationHash: z.string().regex(/^[a-f0-9]{64}$/),
});
const datasetExample = z.object({
  id: z.uuid(),
  prompt: z.string().max(2_000),
  expected: z.string().max(2_000),
}).strict();
export const LocalTrainingModelBaseSchema = z.object({
  label: z.string().trim().min(1).max(240),
  sizeBytes: z.number().int().positive().safe(),
  preference: ModelProjectBaseModelSchema.extend({
    source: z.literal("local"),
    modelAssetId: artifactHash,
    revision: artifactHash,
    tokenizerRevision: artifactHash,
    chatTemplateHash: artifactHash,
  }),
}).strict();
export type LocalTrainingModelBase = z.infer<typeof LocalTrainingModelBaseSchema>;

export const LocalSftReviewRequestSchema = z.object({
  sessionId: resourceId,
  dataset: ModelProjectVersionedRefSchema,
  modelAssetId: artifactHash,
  recipe: SftRecipeSchema.strict(),
}).strict();
export type LocalSftReviewRequest = z.infer<typeof LocalSftReviewRequestSchema>;
export const LocalSftReviewPlanSchema = z.object({
  request: LocalSftReviewRequestSchema,
  datasetName: z.string().min(1).max(500),
  datasetPackageHash: artifactHash,
  trainingDataHash: artifactHash,
  taskIdsHash: artifactHash,
  rowCount: z.number().int().positive(),
  eligibleRows: z.number().int().positive(),
  excludedRows: z.number().int().nonnegative(),
  planHash: artifactHash,
}).strict();
export const LocalSftReviewSchema = z.object({
  plan: LocalSftReviewPlanSchema,
  rows: z.array(z.object({ id: resourceId, prompt: z.string(), target: z.string() }).strict()),
}).strict();
export const LocalSftApprovalSchema = LocalSftReviewPlanSchema.extend({
  approvedAt: z.string().datetime({ offset: true }),
});

const LocalSftTokenizerReportSchema = z.object({
  rowCount: z.number().int().positive(),
  maximumTokens: z.number().int().positive(),
  completionTokens: z.number().int().positive(),
  tokenizationHash: artifactHash,
}).strict();
const LocalSftDeviceReportSchema = z.object({
  ordinal: z.number().int().nonnegative(),
  name: z.string().min(1).max(500),
  capacityBytes: z.number().int().positive().safe(),
  freeBytes: z.number().int().positive().safe(),
  usedBytes: z.number().int().positive().safe(),
  budgetBytes: z.number().int().positive().safe(),
}).strict();
export const LocalSftPreflightReportSchema = z.discriminatedUnion("status", [
  z.object({
    status: z.enum([
      "unsupported_platform", "python_missing", "dependencies_missing", "cuda_unavailable",
      "checkpoint_mismatch", "tokenizer_incompatible", "example_too_long", "lora_incompatible",
      "insufficient_memory", "nonfinite_loss", "probe_failed", "device_busy",
    ]),
    rowId: resourceId.optional(),
    tokens: LocalSftTokenizerReportSchema.optional(),
  }).strict(),
  z.object({
    status: z.literal("ready"),
    tokens: LocalSftTokenizerReportSchema,
    device: LocalSftDeviceReportSchema,
  }).strict(),
]);
export const LocalSftPreflightRequestSchema = z.object({
  sessionId: resourceId,
  planHash: artifactHash,
}).strict();
export const LocalSftPreflightSchema = z.object({
  planHash: artifactHash,
  report: LocalSftPreflightReportSchema,
}).strict();

const localSftRunId = z.uuid();
export const LocalSftRunRequestSchema = LocalSftPreflightRequestSchema.extend({ runId: localSftRunId });
const artifactFile = z.object({ bytes: z.number().int().positive().safe(), sha256: artifactHash }).strict();
const localSftProgress = z.object({
  step: z.number().int().nonnegative(),
  steps: z.number().int().positive(),
  tokens: LocalSftTokenizerReportSchema,
  device: LocalSftDeviceReportSchema,
}).strict();
export const LocalSftRunStateSchema = z.discriminatedUnion("status", [
  z.object({ status: z.enum(["starting", "cancelling"]) }).strict(),
  localSftProgress.extend({ status: z.literal("running") }),
  localSftProgress.extend({
    status: z.literal("completed"),
    files: z.object({
      "adapter_model.safetensors": artifactFile,
      "adapter_config.json": artifactFile,
    }).strict(),
  }),
  localSftProgress.partial().extend({
    status: z.enum(["cancelled", "failed"]),
    reason: z.enum([
      "cancelled", "time_limit", "device_busy", "artifact_invalid", "worker_failed", "worker_stopped",
      "python_missing", "dependencies_missing", "cuda_unavailable", "probe_failed", "tokenizer_incompatible",
      "checkpoint_mismatch", "example_too_long", "lora_incompatible", "insufficient_memory", "nonfinite_loss",
    ]),
  }),
]);
export const LocalSftRunSchema = z.object({
  planHash: artifactHash,
  run: z.object({ id: localSftRunId, state: LocalSftRunStateSchema }).strict().nullable(),
}).strict();
export type LocalSftRun = z.infer<typeof LocalSftRunSchema>;

const valuesSchema = z.object({
  name: fieldText,
  objective: fieldText,
  baseModel: fieldText,
  candidate: fieldText,
  baseline: fieldText,
  dataset: fieldText,
  datasetRevision: positiveInteger,
  split: DatasetSplitSchema.optional(),
  grader: fieldText,
  method: z.enum(["SFT", "GRPO", "Decision", "Weight-space programming"]).optional(),
  adapter: z.enum(["LoRA", "Full fine-tuning"]).optional(),
  learning: z.enum(["One-time training", "Configure continual learning"]).optional(),
  destination: z.enum(["This device", "OpenPond Managed"]).optional(),
  source: z.enum(["Write examples", "Import a local file", "Use an existing dataset"]).optional(),
  graderType: z.enum(["Exact answer", "Code grader", "LLM judge", "Human assessment", "Python correctness"]).optional(),
  fields: fieldText,
  samples: z.number().int().min(1).max(100).optional(),
  outputTokens: z.number().int().min(1).max(4096).optional(),
  epochs: positiveInteger,
  learningRate: nonnegativeNumber,
  seed: z.number().int().min(0).max(2_147_483_647).optional(),
  budget: nonnegativeNumber,
  criterion: fieldText,
  cases: fieldText,
  project: fieldText,
});

export const ResourceSetupDraftSchema = z.object({
  kind: z.enum(["chat", "model", "benchmark", "dataset", "grader"]),
  revision: z.number().int().positive(),
  comparison: z.boolean().optional(),
  benchmarkDefinition: z.object({
    id: z.string().min(1).max(240),
    revision: z.number().int().positive(),
  }).optional(),
  benchmarkModelVersion: BenchmarkModelVersionSchema.optional(),
  managedBenchmarkVersions: ManagedBenchmarkVersionsSchema.optional(),
  managedBenchmarkDataset: ManagedBenchmarkDatasetSchema.nullable().optional(),
  managedBenchmarkProtocol: ManagedBenchmarkProtocolSchema.optional(),
  localBenchmarkInference: z.object({
    device: z.enum(["cpu", "cuda"]),
    maxOutputTokens: z.number().int().min(1).max(2048),
    baseline: LocalBenchmarkModelVersionSchema.optional(),
  }).strict().optional(),
  candidateRef: z.object({
    projectId: z.string().min(1).max(240),
    versionId: z.string().min(1).max(240),
    artifactId: z.string().min(1).max(240),
    bundleHash: z.string().regex(/^[a-f0-9]{64}$/),
  }).optional(),
  localCandidate: localModelRef.optional(),
  localBaseline: localModelRef.optional(),
  localTrainingBase: LocalTrainingModelBaseSchema.optional(),
  localSftApproval: LocalSftApprovalSchema.optional(),
  datasetExamples: datasetExample.array().max(50).optional(),
  datasetInputsDirty: z.boolean().optional(),
  trainingRecipes: z.object({
    sft: ModelProjectRecipeDocumentSchema.extend({ method: z.literal("sft") }).optional(),
    grpo: ModelProjectRecipeDocumentSchema.extend({ method: z.literal("grpo") }).optional(),
  }).strict().optional(),
  managedTrainingInputs: z.object({
    accountKey: z.string().min(1).max(4_000),
    teamId: z.string().min(1).max(500),
    actorId: z.string().min(1).max(500),
    base: z.object({
      label: z.string().min(1).max(500),
      preference: ModelProjectBaseModelSchema,
    }).strict().optional(),
    batch: z.object({
      label: z.string().min(1).max(500),
      method: z.enum(["sft", "grpo"]),
      reference: ModelProjectVersionedRefSchema,
    }).strict().optional(),
    validation: ModelProjectVersionedRefSchema.optional(),
    validationSplit: z.enum(["validation", "frozen_eval"]).optional(),
  }).strict().optional(),
  graderExamples: z.object({
    id: z.uuid(),
    taskId: fieldText,
    positive: fieldText,
    negative: fieldText,
    verifierSource: z.string().max(24_000).optional(),
    savedSetupRevision: positiveInteger,
  }).strict().optional(),
  managedGrader: z.object({
    accountKey: z.string().min(1).max(4_000),
    teamId: z.string().min(1).max(500),
    actorId: z.string().min(1).max(500),
    method: z.enum(["LLM judge", "Human assessment", "Python correctness"]),
    draft: z.object({ id: resourceId, revision: z.number().int().positive(), contentHash: artifactHash }).strict().optional(),
    release: z.object({ id: resourceId, revision: z.number().int().positive(), contentHash: artifactHash }).strict().optional(),
  }).strict().optional(),
  datasetRef: z.object({
    id: z.string().min(1).max(240),
    revision: z.number().int().positive(),
    contentHash: z.string().regex(/^[a-f0-9]{64}$/).optional(),
  }).optional(),
  values: valuesSchema,
});
export type ResourceSetupDraft = z.infer<typeof ResourceSetupDraftSchema>;

export const BenchmarkRunPinSchema = z.object({
  id: z.string().min(1).max(240),
  revision: z.number().int().positive(),
  draftHash: z.string().regex(/^[a-f0-9]{64}$/),
  setupHash: z.string().regex(/^[a-f0-9]{64}$/),
  modelVersion: z.object({
    projectId: resourceId, jobId: resourceId, versionHash: artifactHash,
    artifact: z.object({ id: resourceId, contentHash: artifactHash }).strict(),
  }).strict().optional(),
}).strict();
export type BenchmarkRunPin = z.infer<typeof BenchmarkRunPinSchema>;

const LocalTrainingDeviceSchema = z.object({
  name: z.string().min(1).max(500),
  memoryMiB: z.number().int().positive(),
  freeMiB: z.number().int().nonnegative(),
}).strict().refine(device => device.freeMiB <= device.memoryMiB, "Free memory exceeds total device memory.");

export const LocalTrainingRuntimeSchema = z.discriminatedUnion("status", [
  z.object({
    status: z.enum(["unsupported_platform", "python_missing", "dependencies_missing", "cuda_unusable", "probe_failed"]),
  }).strict(),
  z.object({
    status: z.literal("ready"),
    python: z.string().min(1).max(80),
    cuda: z.string().min(1).max(80),
    packages: z.object({
      torch: z.string().min(1).max(100),
      transformers: z.string().min(1).max(100),
      peft: z.string().min(1).max(100),
      accelerate: z.string().min(1).max(100),
      safetensors: z.string().min(1).max(100),
    }).strict(),
    devices: z.array(z.object({
      ordinal: z.number().int().min(0).max(255),
      device: LocalTrainingDeviceSchema,
      computeCapability: z.tuple([z.number().int().min(1).max(99), z.number().int().min(0).max(99)]),
    }).strict()).min(1).max(256),
  }).strict(),
]);

export const LocalTrainingComputeSchema = z.object({
  status: z.enum(["cuda_detected", "cuda_tools_unavailable", "devices_unavailable"]),
  devices: z.array(LocalTrainingDeviceSchema).max(256),
  runtime: LocalTrainingRuntimeSchema.optional(),
}).strict();
export type LocalTrainingCompute = z.infer<typeof LocalTrainingComputeSchema>;
