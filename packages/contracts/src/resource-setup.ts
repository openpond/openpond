import { z } from "zod";
import { DatasetSplitSchema } from "openpond-sdk/taskset-drafts";
import { ModelProjectBaseModelSchema, ModelProjectRecipeDocumentSchema, ModelProjectVersionedRefSchema } from "openpond-sdk/model-projects";

const fieldText = z.string().max(2_000).optional();
const positiveInteger = z.number().int().positive().optional();
const nonnegativeNumber = z.number().nonnegative().optional();
const artifactHash = z.string().regex(/^[a-f0-9]{64}$/);
const resourceId = z.string().min(1).max(240);
export const BenchmarkModelVersionSchema = z.discriminatedUnion("location", [
  z.object({ location: z.literal("local"), projectId: resourceId, versionId: resourceId,
    artifactId: resourceId, bundleHash: artifactHash }).strict(),
  z.object({ location: z.literal("cloud"), modelProjectId: resourceId, jobId: resourceId,
    teamId: resourceId, versionHash: artifactHash }).strict(),
]);
export type BenchmarkModelVersion = z.infer<typeof BenchmarkModelVersionSchema>;
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
  candidateRef: z.object({
    projectId: z.string().min(1).max(240),
    versionId: z.string().min(1).max(240),
    artifactId: z.string().min(1).max(240),
    bundleHash: z.string().regex(/^[a-f0-9]{64}$/),
  }).optional(),
  localCandidate: localModelRef.optional(),
  localBaseline: localModelRef.optional(),
  localTrainingBase: LocalTrainingModelBaseSchema.optional(),
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
    savedSetupRevision: positiveInteger,
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
