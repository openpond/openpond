import { z } from "zod";

import { contentHash } from "./hash.js";
import { ContinualBenchPanelRoleSchema } from "./schema.js";

const Id = z.string().trim().min(1).max(240);
const Hash = z.string().regex(/^[a-f0-9]{64}$/);
const TaskRef = z.object({ id: Id, contentHash: Hash }).strict();

export const ContinualBenchPortableTaskSchema = z.object({
  id: Id,
  familyId: Id,
  contentHash: Hash,
  prompt: z.string().max(1_000_000).optional(),
  payload: z.record(z.string(), z.unknown()).optional(),
}).strict();

export const ContinualBenchPortablePanelSchema = z.object({
  id: Id,
  role: ContinualBenchPanelRoleSchema,
  passLabel: Id.nullable(),
  taskIds: z.array(Id).min(1).max(1_000_000),
  disclosurePhase: z.enum(["review", "evaluation", "final"]),
  optimizerEligible: z.boolean(),
}).strict().superRefine((panel, context) => {
  const shouldOptimize = panel.role === "correction" || panel.role === "training_eligible";
  if (panel.optimizerEligible !== shouldOptimize) {
    context.addIssue({
      code: "custom",
      path: ["optimizerEligible"],
      message: "Only correction and training-eligible panels may be optimizer eligible.",
    });
  }
  if (panel.role === "frozen_final" && panel.disclosurePhase !== "final") {
    context.addIssue({
      code: "custom",
      path: ["disclosurePhase"],
      message: "The frozen-final panel may only be disclosed in the final phase.",
    });
  }
  if (new Set(panel.taskIds).size !== panel.taskIds.length) {
    context.addIssue({ code: "custom", path: ["taskIds"], message: "Panel task ids must be unique." });
  }
});

export const ContinualBenchPortablePassSchema = z.object({
  label: Id,
  familyIds: z.array(Id).min(1).max(100_000),
}).strict();

export const ContinualBenchOpenPondExecutionSchema = z.object({
  adapter: z.literal("openpond"),
  apiBaseUrl: z.string().url().optional(),
  series: z.record(z.string(), z.unknown()),
}).strict();

export const ContinualBenchPortableManifestSchema = z.object({
  schemaVersion: z.literal("openpond.continualBenchManifest.v1"),
  id: Id,
  revision: z.number().int().positive(),
  name: z.string().trim().min(1).max(500),
  description: z.string().trim().min(1).max(20_000),
  license: z.string().trim().min(1).max(100),
  source: z.object({
    repository: z.string().trim().min(1).max(2_000).nullable(),
    commit: z.string().trim().min(1).max(500).nullable(),
    generatedBy: z.string().trim().min(1).max(2_000),
  }).strict(),
  split: z.object({
    seed: Id,
    correctionCasesPerFamily: z.number().int().positive().max(100),
    correctionSelection: z.enum(["stable_hash", "minimize_prompt_similarity"]),
    semanticSimilarityThreshold: z.number().gt(0).lte(1),
  }).strict(),
  passes: z.array(ContinualBenchPortablePassSchema).min(1).max(1_000),
  tasks: z.array(ContinualBenchPortableTaskSchema).min(1).max(1_000_000),
  panels: z.array(ContinualBenchPortablePanelSchema).min(1).max(100_000),
  grader: z.object({
    id: Id,
    contentHash: Hash,
    outcomeScale: z.object({ minimum: z.number().finite(), maximum: z.number().finite() }).strict(),
  }).strict(),
  evaluation: z.object({
    seeds: z.array(z.number().int()).min(1).max(100),
    repetitions: z.number().int().positive().max(100),
    confidenceLevel: z.number().gt(0).lt(1),
    pairedBootstrapSamples: z.number().int().min(1_000).max(1_000_000),
  }).strict(),
  execution: ContinualBenchOpenPondExecutionSchema.optional(),
  contentHash: Hash,
}).strict().superRefine((manifest, context) => {
  const taskIds = manifest.tasks.map((task) => task.id);
  if (new Set(taskIds).size !== taskIds.length) {
    context.addIssue({ code: "custom", path: ["tasks"], message: "Manifest task ids must be unique." });
  }
  const knownTasks = new Set(taskIds);
  for (const [index, panel] of manifest.panels.entries()) {
    if (panel.taskIds.some((id) => !knownTasks.has(id))) {
      context.addIssue({ code: "custom", path: ["panels", index, "taskIds"], message: "Every panel task must exist in the manifest inventory." });
    }
  }
  const passLabels = manifest.passes.map((pass) => pass.label);
  if (new Set(passLabels).size !== passLabels.length) {
    context.addIssue({ code: "custom", path: ["passes"], message: "Pass labels must be unique." });
  }
  const families = new Set(manifest.tasks.map((task) => task.familyId));
  const assigned = manifest.passes.flatMap((pass) => pass.familyIds);
  if (new Set(assigned).size !== assigned.length) {
    context.addIssue({ code: "custom", path: ["passes"], message: "An issue family may belong to only one pass." });
  }
  if (assigned.some((familyId) => !families.has(familyId))) {
    context.addIssue({ code: "custom", path: ["passes"], message: "Every assigned family must exist in the task inventory." });
  }
});

export type ContinualBenchPortableTask = z.infer<typeof ContinualBenchPortableTaskSchema>;
export type ContinualBenchPortablePanel = z.infer<typeof ContinualBenchPortablePanelSchema>;
export type ContinualBenchPortableManifest = z.infer<typeof ContinualBenchPortableManifestSchema>;

export function sealPortableManifest(
  input: Omit<ContinualBenchPortableManifest, "contentHash">,
): ContinualBenchPortableManifest {
  return ContinualBenchPortableManifestSchema.parse({ ...input, contentHash: contentHash(input) });
}

export function verifyPortableManifest(manifest: ContinualBenchPortableManifest): boolean {
  const parsed = ContinualBenchPortableManifestSchema.parse(manifest);
  const { contentHash: declared, ...unsealed } = parsed;
  return declared === contentHash(unsealed);
}

export function portableTaskRef(task: ContinualBenchPortableTask): z.infer<typeof TaskRef> {
  return TaskRef.parse({ id: task.id, contentHash: task.contentHash });
}
