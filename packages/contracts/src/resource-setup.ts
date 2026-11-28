import { z } from "zod";
import { DatasetSplitSchema } from "openpond-sdk/taskset-drafts";

const fieldText = z.string().max(2_000).optional();
const positiveInteger = z.number().int().positive().optional();
const nonnegativeNumber = z.number().nonnegative().optional();
const localModelRef = z.object({
  modelId: z.string().min(1).max(500),
  configurationHash: z.string().regex(/^[a-f0-9]{64}$/),
});
const datasetExample = z.object({
  id: z.uuid(),
  prompt: z.string().max(2_000),
  expected: z.string().max(2_000),
}).strict();
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
  candidateRef: z.object({
    projectId: z.string().min(1).max(240),
    versionId: z.string().min(1).max(240),
    artifactId: z.string().min(1).max(240),
    bundleHash: z.string().regex(/^[a-f0-9]{64}$/),
  }).optional(),
  localCandidate: localModelRef.optional(),
  localBaseline: localModelRef.optional(),
  datasetExamples: datasetExample.array().max(50).optional(),
  datasetInputsDirty: z.boolean().optional(),
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
}).strict();
export type BenchmarkRunPin = z.infer<typeof BenchmarkRunPinSchema>;

export const LocalTrainingComputeSchema = z.object({
  status: z.enum(["cuda_detected", "cuda_tools_unavailable", "devices_unavailable"]),
  devices: z.array(z.object({
    name: z.string().min(1).max(500),
    memoryMiB: z.number().int().positive(),
    freeMiB: z.number().int().nonnegative(),
  }).strict()).max(256),
}).strict();
export type LocalTrainingCompute = z.infer<typeof LocalTrainingComputeSchema>;
