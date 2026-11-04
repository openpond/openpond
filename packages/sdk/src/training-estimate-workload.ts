import { z } from "zod";
import { ModelProjectBaseModelSchema, ModelProjectImmutableRefSchema } from "./model-projects.js";

const Hash = ModelProjectImmutableRefSchema.shape.contentHash;
const Count = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const Reason = z.string().trim().min(1).max(1000);
const Coverage = z.enum(["complete", "bounded", "unavailable"]);

const Identity = z.object({
  baseModel: ModelProjectBaseModelSchema.extend({
    revision: z.string().trim().min(1).max(256),
    tokenizerRevision: z.string().trim().min(1).max(256),
    chatTemplateHash: Hash,
  }).strict(),
  /** Hash the full verified recipe, including optimizer and sampling settings. */
  recipeHash: Hash,
  harnessRunManifest: ModelProjectImmutableRefSchema,
  harnessRelease: ModelProjectImmutableRefSchema,
  dataset: ModelProjectImmutableRefSchema,
  evaluationDataset: ModelProjectImmutableRefSchema.nullable(),
  evidenceSets: z.array(ModelProjectImmutableRefSchema).max(10_000),
}).strict();

const Preprocessing = z.object({
  version: z.string().trim().min(1).max(191),
  /** Includes policy framing, template invocation, admission and mask code. */
  implementationHash: Hash,
  /** Hash of the verified tokenizer file inventory (paths, sizes and hashes). */
  tokenizerAssetsHash: Hash,
  enableThinking: z.literal(false),
}).strict();

const SftTokens = z.object({
  promptTokens: Count,
  retainedPromptTokens: Count,
  /** Includes the final assistant terminal marker; prompt labels are masked. */
  targetTokens: Count,
  inputTokens: Count,
  truncatedPrompts: Count,
}).strict().superRefine((tokens, context) => {
  if (tokens.retainedPromptTokens > tokens.promptTokens ||
      tokens.inputTokens !== tokens.retainedPromptTokens + tokens.targetTokens ||
      (tokens.truncatedPrompts === 0) !== (tokens.promptTokens === tokens.retainedPromptTokens)) {
    context.addIssue({ code: "custom", message: "SFT tokens must preserve the target and partition the retained input" });
  }
});

/** Totals cover only the exact counted subset, never an extrapolated population.
 * inputsHash binds its ordered row IDs/messages or exact initial request payloads.
 * Bounded coverage records a preflight limit; it is not a statistical estimate. */
const Population = z.object({
  coverage: Coverage,
  total: Count.nullable(),
  counted: Count,
  inputsHash: Hash.nullable(),
  reason: Reason.nullable(),
}).strict();

function verifyPopulation(value: z.infer<typeof Population> & { totals: unknown }, context: z.RefinementCtx) {
  if (value.total !== null && value.counted > value.total)
    context.addIssue({ code: "custom", path: ["counted"], message: "Counted membership exceeds the population" });
  if (value.coverage === "unavailable") {
    if (value.counted !== 0 || value.totals !== null || value.inputsHash !== null || !value.reason)
      context.addIssue({ code: "custom", message: "Unavailable counts require a reason and no token evidence" });
  } else {
    if (value.totals === null || value.inputsHash === null)
      context.addIssue({ code: "custom", message: "Counted membership requires exact inputs and token totals" });
    if (value.coverage === "complete" && (value.total === null || value.counted !== value.total))
      context.addIssue({ code: "custom", message: "Complete coverage must count the entire declared population" });
    if (value.coverage === "bounded" && !value.reason)
      context.addIssue({ code: "custom", path: ["reason"], message: "Bounded coverage must explain its limit" });
  }
}

const PromptPopulation = Population.extend({ totals: z.object({ promptTokens: Count }).strict().nullable() })
  .superRefine(verifyPopulation).superRefine((value, context) => {
  if (value.totals && value.totals.promptTokens < value.counted)
    context.addIssue({ code: "custom", path: ["totals"], message: "Each counted initial request requires a nonempty prompt" });
});
const SftPopulation = Population.extend({ totals: SftTokens.nullable() })
  .superRefine(verifyPopulation).superRefine((value, context) => {
  if (value.totals && (value.totals.truncatedPrompts > value.counted ||
      value.totals.retainedPromptTokens < value.counted || value.totals.targetTokens < value.counted))
    context.addIssue({ code: "custom", path: ["totals"], message: "Each counted SFT row requires context and a complete target" });
});

const Common = {
  schemaVersion: z.literal("openpond.trainingEstimateWorkload.v1"),
  identity: Identity.nullable(),
  /** Required when immutable identity or native preprocessing cannot be verified. */
  unavailableReason: Reason.nullable(),
};

/** Read-only native preprocessing evidence, independent of throughput or price.
 * Planned counts describe a successful full schedule, never actual consumption. */
export const TrainingEstimateWorkloadSchema = z.discriminatedUnion("method", [
  z.object({
    ...Common,
    method: z.literal("sft"),
    preprocessing: Preprocessing.extend({
      maxSequenceLength: Count.min(2),
      promptTruncation: z.literal("left_preserve_complete_target"),
      targetMask: z.literal("completion_only"),
    }).strict().nullable(),
    /** One exposure per distinct admitted row, before schedule repetition. */
    trainingRows: SftPopulation,
    evaluationRows: Count.nullable(),
    /** Initial held-out requests only; held-out targets never enter SFT loss. */
    evaluationInitialRequests: PromptPopulation,
    evaluationGeneratedCompletionTokens: z.null(),
    evaluationGeneratedTokensReason: Reason,
    planned: z.object({
      /** Native seeded epoch order, capped by maxSteps × batch × accumulation. */
      exampleExposures: Count.nullable(),
      optimizerSteps: Count.nullable(),
      /** Hash the ordered row IDs with repetition after the native step cap. */
      exposuresHash: Hash.nullable(),
      tokenTotals: SftTokens.nullable(),
      reason: Reason.nullable(),
    }).strict(),
  }).strict(),
  z.object({
    ...Common,
    method: z.literal("grpo"),
    preprocessing: Preprocessing.extend({
      maxPromptTokens: Count.positive(),
      contextAdmission: z.literal("native_policy_context"),
      addGenerationPrompt: z.literal(true),
    }).strict().nullable(),
    /** Distinct released rows, independent of repeated group/slot requests. */
    trainingRows: Count.nullable(),
    evaluationRows: Count.nullable(),
    /** Exact initial request variants, including seeds, tools and context. */
    trainingInitialRequests: PromptPopulation,
    evaluationInitialRequests: PromptPopulation,
    /** Future generations and tool trajectories have no exact preflight count. */
    generatedCompletionTokens: z.null(),
    subsequentToolTurnPromptTokens: z.null(),
    generatedTokensReason: Reason,
  }).strict(),
]).superRefine((workload, context) => {
  const populations = workload.method === "sft"
    ? [workload.trainingRows, workload.evaluationInitialRequests]
    : [workload.trainingInitialRequests, workload.evaluationInitialRequests];
  if (!workload.identity || !workload.preprocessing) {
    if (!workload.unavailableReason || populations.some(value => value.coverage !== "unavailable") ||
        workload.method === "sft" && workload.planned.tokenTotals !== null)
      context.addIssue({ code: "custom", message: "Native token counts require verified identity and preprocessing; otherwise explain their unavailability" });
  }
  if (workload.method === "sft") {
    const plan = workload.planned;
    if (workload.preprocessing) {
      const limit = workload.preprocessing.maxSequenceLength;
      if (workload.trainingRows.totals && workload.trainingRows.totals.inputTokens > limit * workload.trainingRows.counted ||
          plan.tokenTotals && plan.exampleExposures !== null && plan.tokenTotals.inputTokens > limit * plan.exampleExposures)
        context.addIssue({ code: "custom", message: "SFT token totals exceed the native sequence limit" });
    }
    if ((plan.exampleExposures === null) !== (plan.optimizerSteps === null) ||
        (plan.exampleExposures === null) !== (plan.exposuresHash === null))
      context.addIssue({ code: "custom", path: ["planned"], message: "A native schedule requires exposures, steps and ordered membership together" });
    if (plan.exampleExposures !== null && (!workload.identity || workload.trainingRows.total === null ||
        plan.optimizerSteps === null || plan.optimizerSteps > plan.exampleExposures ||
        (plan.exampleExposures === 0) !== (plan.optimizerSteps === 0)))
      context.addIssue({ code: "custom", path: ["planned"], message: "A native schedule requires immutable identity, admitted row membership and valid step counts" });
    if (plan.tokenTotals && (plan.exampleExposures === null ||
        plan.tokenTotals.truncatedPrompts > plan.exampleExposures ||
        plan.tokenTotals.retainedPromptTokens < plan.exampleExposures || plan.tokenTotals.targetTokens < plan.exampleExposures))
      context.addIssue({ code: "custom", path: ["planned", "tokenTotals"], message: "Planned tokens must cover the exact scheduled exposures" });
    if ((!workload.identity || plan.exampleExposures === null || plan.tokenTotals === null) && !plan.reason)
      context.addIssue({ code: "custom", path: ["planned", "reason"], message: "Incomplete planned workload requires a reason" });
  } else if (workload.preprocessing) {
    const value = workload.trainingInitialRequests;
    if (value.totals && value.totals.promptTokens > workload.preprocessing.maxPromptTokens * value.counted)
      context.addIssue({ code: "custom", message: "Training initial request token totals exceed native prompt admission" });
  }
});

export type TrainingEstimateWorkload = z.infer<typeof TrainingEstimateWorkloadSchema>;
