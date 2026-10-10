import { z } from "zod";
import {
  TasksetSplitSchema,
  TasksetCapabilityManifestSchema,
  TaskPolicyBoundarySchema,
  GraderSpecSchema,
  GraderFixtureLabelSchema,
} from "./taskset-draft-core.js";
import {
  GeneratedTaskFileSchema,
  TasksetReadinessReportSchema,
  TrainingPathRecommendationSchema,
} from "./taskset-authored-contracts.js";

const Id = z.string().trim().min(1).max(240);
const Text = z.string().trim().min(1).max(5_000);
export const TrainingTacticSchema = z.enum([
  "no_training",
  "prompting",
  "retrieval",
  "sft",
  "preference",
  "grpo_rft",
  "sdft_opsd",
  "sdpo",
  "agentic_rl",
]);
export const TaskDesignFixtureTemplateSchema = z.object({
  id: Id,
  taskIndex: z.number().int().nonnegative(),
  label: GraderFixtureLabelSchema,
  output: z.record(z.string(), z.unknown()),
  infrastructureError: z.string().trim().min(1).max(10_000).nullable(),
  expectedPassed: z.boolean(),
  expectedRewardEligible: z.boolean(),
  metadata: z.record(z.string(), z.unknown()).default({}),
});
export const CapabilityDiagnosisSchema = z.object({
  schemaVersion: z.literal("openpond.capabilityDiagnosis.v1"),
  summary: z.string().trim().min(1).max(10_000),
  stableBehavior: z.array(Text).max(100).default([]),
  changingKnowledge: z.array(Text).max(100).default([]),
  requiredContext: z.array(Text).max(100).default([]),
  requiredTools: z.array(Id).max(100).default([]),
  intervention: TrainingTacticSchema,
  trainingEligible: z.boolean(),
  rationale: z.array(Text).min(1).max(100),
  confidence: z.number().min(0).max(1),
});
export const TaskExampleProposalSchema = z.object({
  id: Id,
  sourceId: Id,
  sourceTurnId: Id.nullable(),
  split: TasksetSplitSchema,
  origin: z.enum(["extracted", "corrected", "synthetic", "expert_authored"]),
  inputPrompt: z.string().trim().min(1).max(100_000),
  expectedOutputText: z.string().trim().min(1).max(200_000).nullable(),
  rationale: Text,
});
export const TaskDesignProposalSchema = z.object({
  schemaVersion: z.literal("openpond.taskDesignProposal.v1"),
  id: Id,
  name: z.string().trim().min(1).max(500),
  objective: z.string().trim().min(1).max(20_000),
  diagnosis: CapabilityDiagnosisSchema.default({
    schemaVersion: "openpond.capabilityDiagnosis.v1",
    summary: "Reproduce the selected approved behavior.",
    stableBehavior: [],
    changingKnowledge: [],
    requiredContext: [],
    requiredTools: [],
    intervention: "sft",
    trainingEligible: true,
    rationale: ["The selected examples were supplied as demonstrations."],
    confidence: 0.5,
  }),
  taskKind: TasksetCapabilityManifestSchema.shape.taskKind,
  sourceIds: z.array(Id).min(1).max(100_000),
  assumptions: z.array(Text).max(1_000),
  successCriteria: z.array(Text).min(1).max(1_000),
  proposedGraders: z.array(GraderSpecSchema).max(1_000).default([]),
  graderFixtures: z.array(TaskDesignFixtureTemplateSchema).max(100_000).default([]),
  generatedFiles: z.array(GeneratedTaskFileSchema).max(1_000).default([]),
  proposedExamples: z.array(TaskExampleProposalSchema).max(100_000).default([]),
  proposedMethod: TasksetReadinessReportSchema.shape.recommendedMethod,
  trainingPath: TrainingPathRecommendationSchema.nullable().default(null),
  policy: TaskPolicyBoundarySchema,
  warnings: z.array(z.string().trim().min(1)).default([]),
  createdAt: z.string().trim().min(1),
});
export type TaskDesignFixtureTemplate = z.infer<typeof TaskDesignFixtureTemplateSchema>;
export type CapabilityDiagnosis = z.infer<typeof CapabilityDiagnosisSchema>;
export type TaskExampleProposal = z.infer<typeof TaskExampleProposalSchema>;
export type TaskDesignProposal = z.infer<typeof TaskDesignProposalSchema>;
export type TrainingTactic = z.infer<typeof TrainingTacticSchema>;
