import { z } from "zod";
import { ProfileEvaluationRunSourceSchema } from "@openpond/evals";
import { StandaloneHarnessExperimentSourceSchema } from "@openpond/evals/experiments";
import { RewardReleaseSchema } from "@openpond/evals/rewards";
import { TasksetCatalogReleaseRefSchema } from "./taskset-catalog.js";
import { EvaluationMessagesSchema, EvaluationProjectContextSchema } from "./evaluation-project-context.js";
import { ExperimentGraderSelectionSchema } from "./experiment-contracts.js";
import { ExperimentFieldMappingsSchema } from "./experiment-field-mappings.js";
import { HarnessExperimentPolicySchema } from "./harness-experiment-policy.js";

const Id = z.string().min(1).max(500);
const Choice = z.string().max(500);
const RawNumber = z.string().max(100);
const TaskIds = z.array(Id).max(10_000).nullable();
const Hash = z.string().regex(/^[a-f0-9]{64}$/);

/** Source identity is independent of picker labels. A workspace may be selected
 * before its revision has loaded; a saved non-null revision must be rechecked
 * by the editor and must never silently advance to the current workspace. */
export const HostedEvaluationDatasetDraftSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("workspace"), id: Id,
    revision: z.number().int().positive().nullable(),
    ownerUserId: Id.optional(), taskIds: TaskIds,
  }).strict(),
  z.object({
    kind: z.literal("published"), release: TasksetCatalogReleaseRefSchema,
    taskIds: TaskIds,
  }).strict(),
  z.object({
    kind: z.literal("profile"), profileRepositoryId: Id,
    sourceRevision: Id, release: TasksetCatalogReleaseRefSchema,
    name: z.string().max(500), definitionId: Choice, taskIds: TaskIds,
  }).strict(),
]);

export const HostedEvaluationWorkflowDraftSchema = z.object({
  repositoryId: Id, sourceRevision: Id, definitionId: Id,
  workflowId: Id, label: z.string().max(500),
}).strict();

/** Retain the exact released Profile target, including prepared source identity
 * when available. Missing controls remain empty rather than admitting a run. */
export const HostedEvaluationProfileDraftSchema = z.object({
  profileRepositoryId: Choice, sourceRevision: Choice, definitionId: Choice,
  sourceHash: Hash.nullable(), release: TasksetCatalogReleaseRefSchema.nullable(),
  taskIds: TaskIds, source: ProfileEvaluationRunSourceSchema.nullable().optional(),
}).strict();

/** Portable hosted editor state, not an execution request. Numeric text retains
 * blanks and partially typed values. Null task/grader selections mean automatic
 * selection; explicit empty arrays remain empty. Immutable sources and selected
 * grader versions are retained without granting access or execution authority.
 * This snapshot can remain inactive while another Experiment action is edited. */
export const HostedEvaluationExperimentFormDraftSchema = z.object({
  selectedDatasetId: Choice,
  dataset: HostedEvaluationDatasetDraftSchema.nullable(),
  workspaceMode: z.enum(["recorded", "model"]).nullable(),
  mode: z.enum(["hosted_chat", "fixture"]),
  executionMode: z.enum(["model", "model_harness", "model_harness_profile"]),
  name: z.string().max(500), modelId: Choice,
  messages: EvaluationMessagesSchema,
  temperature: RawNumber, topP: RawNumber, maxOutputTokens: RawNumber,
  budget: RawNumber, seedText: z.string().max(10_000),
  reasoningEffort: HarnessExperimentPolicySchema.shape.reasoningEffort.unwrap(),
  sourceId: Choice, harness: StandaloneHarnessExperimentSourceSchema.nullable(),
  project: EvaluationProjectContextSchema.nullable(),
  members: z.array(z.object({ taskId: Id, fixtureId: Id.nullable() }).strict()).max(10_000).nullable(),
  graderIds: z.array(Id).max(100).nullable(),
  graders: z.array(ExperimentGraderSelectionSchema).max(100),
  graderMappings: z.record(Id, ExperimentFieldMappingsSchema),
  selectedGraders: z.array(RewardReleaseSchema).max(100),
  workflow: HostedEvaluationWorkflowDraftSchema.nullable(),
  profile: HostedEvaluationProfileDraftSchema.nullable(),
}).strict();

export type HostedEvaluationDatasetDraft = z.infer<typeof HostedEvaluationDatasetDraftSchema>;
export type HostedEvaluationWorkflowDraft = z.infer<typeof HostedEvaluationWorkflowDraftSchema>;
export type HostedEvaluationProfileDraft = z.infer<typeof HostedEvaluationProfileDraftSchema>;
export type HostedEvaluationExperimentFormDraft = z.infer<typeof HostedEvaluationExperimentFormDraftSchema>;
