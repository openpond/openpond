import { LearningDomainError } from "./learning/errors.js";
import { z } from "zod";
import { ImmutableAssetRefSchema, ImmutableReleaseRefSchema, ReleaseHashSchema, ReleaseIdSchema, contentHash } from "@openpond/harness";

import { gradeEvidence, type AttemptEvidence, type CustomVerifierRunner, type ModelJudgeRunner } from "./graders.js";
import { CustomVerifierGraderSpecSchema, DeterministicGraderSpecSchema, GraderSpecSchema, HumanGraderSpecSchema, ModelJudgeGraderSpecSchema, type GraderSpec, type TaskRecord } from "./tasksets.js";
import { assertBoundedTaskJson, validateTaskSchema } from "./task-schema.js";

const bindingFields = { id: true, version: true, weight: true, hardGate: true, rewardEligible: true, privileged: true } as const;
export const RewardImplementationSchema = z.union([
  DeterministicGraderSpecSchema.omit(bindingFields),
  ModelJudgeGraderSpecSchema.omit(bindingFields),
  CustomVerifierGraderSpecSchema.omit(bindingFields),
  HumanGraderSpecSchema.omit(bindingFields),
  z.object({ kind: z.literal("learned_model"), modelVersion: ImmutableReleaseRefSchema, inputContract: ImmutableAssetRefSchema }).strict(),
]);

export const RewardReleaseContentSchema = z.object({
  schemaVersion: z.literal("openpond.rewardRelease.v1"),
  id: ReleaseIdSchema,
  revision: z.number().int().positive(),
  name: z.string().trim().min(1).max(500),
  description: z.string().max(10_000),
  implementation: RewardImplementationSchema,
  rawScore: z.object({ minimum: z.number().finite(), maximum: z.number().finite() }).strict(),
  assets: z.array(ImmutableAssetRefSchema).max(1_000),
}).strict().superRefine((reward, context) => {
  if (reward.rawScore.minimum >= reward.rawScore.maximum) context.addIssue({ code: "custom", path: ["rawScore"], message: "A raw score contract requires minimum < maximum." });
  if (reward.implementation.kind !== "learned_model" && (reward.rawScore.minimum !== 0 || reward.rawScore.maximum !== 1)) context.addIssue({ code: "custom", path: ["rawScore"], message: "Portable graders currently return scores in [0, 1]." });
  if (reward.implementation.kind === "schema") {
    const report = validateTaskSchema(reward.implementation.config.jsonSchema);
    if (!report.valid) context.addIssue({ code: "custom", path: ["implementation", "config", "jsonSchema"], message: report.issues[0]!.message });
  }
});
export const RewardReleaseSchema = RewardReleaseContentSchema.safeExtend({ contentHash: ReleaseHashSchema }).strict();
export const RewardReleaseRefSchema = ImmutableReleaseRefSchema.extend({ revision: z.number().int().positive() }).strict();

export const RewardNormalizationSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("identity") }).strict(),
  z.object({ kind: z.literal("linear"), minimum: z.number().finite(), maximum: z.number().finite(), direction: z.enum(["higher", "lower"]) }).strict(),
]);
export const RewardBindingSourceSchema = z.object({
  graderId: ReleaseIdSchema,
  reward: RewardReleaseRefSchema,
  role: z.enum(["training", "evaluation"]),
  normalization: RewardNormalizationSchema,
  weight: z.number().nonnegative().max(1_000),
  required: z.boolean(),
  hardGate: z.boolean(),
  privileged: z.boolean(),
  fixtureRefs: z.array(ImmutableReleaseRefSchema).max(1_000),
}).strict();
export const RewardBindingContentSchema = z.object({
  schemaVersion: z.literal("openpond.rewardBinding.v1"),
  id: ReleaseIdSchema,
  revision: z.number().int().positive(),
  sources: z.array(RewardBindingSourceSchema).min(1).max(100),
  aggregation: z.literal("weighted_mean"),
  unscorable: z.literal("exclude_optional_require_all_required"),
}).strict().superRefine((binding, context) => {
  if (new Set(binding.sources.map((source) => source.graderId)).size !== binding.sources.length) context.addIssue({ code: "custom", path: ["sources"], message: "Bound grader identities must be unique." });
  if (!binding.sources.some((source) => source.weight > 0)) context.addIssue({ code: "custom", path: ["sources"], message: "A binding needs at least one positively weighted source." });
  for (const [index, source] of binding.sources.entries()) {
    if (source.hardGate && !source.required) context.addIssue({ code: "custom", path: ["sources", index], message: "A hard gate must be required." });
    if (source.normalization.kind === "linear" && source.normalization.minimum >= source.normalization.maximum) context.addIssue({ code: "custom", path: ["sources", index, "normalization"], message: "Linear normalization requires minimum < maximum." });
  }
});
export const RewardBindingSchema = RewardBindingContentSchema.safeExtend({ contentHash: ReleaseHashSchema }).strict();

export const BoundRewardResultSchema = z.object({
  graderId: ReleaseIdSchema,
  reward: RewardReleaseRefSchema,
  role: z.enum(["training", "evaluation"]),
  status: z.enum(["scored", "pending", "unavailable", "failed"]),
  rawScore: z.number().finite().nullable(),
  normalizedScore: z.number().min(0).max(1).nullable(),
  passed: z.boolean().nullable(),
  evidenceHashes: z.array(ReleaseHashSchema).max(1_000),
  message: z.string().max(20_000).nullable(),
}).strict();
export const RewardCompositionContentSchema = z.object({
  schemaVersion: z.literal("openpond.rewardComposition.v1"),
  binding: RewardReleaseRefSchema,
  taskHash: ReleaseHashSchema,
  outputHash: ReleaseHashSchema,
  results: z.array(BoundRewardResultSchema).min(1).max(100),
  training: z.object({ status: z.enum(["scored", "unscorable", "not_configured"]), score: z.number().min(0).max(1).nullable(), passed: z.boolean().nullable() }).strict(),
  evaluation: z.object({ status: z.enum(["scored", "unscorable", "not_configured"]), score: z.number().min(0).max(1).nullable(), passed: z.boolean().nullable() }).strict(),
}).strict();
export const RewardCompositionSchema = RewardCompositionContentSchema.extend({ contentHash: ReleaseHashSchema }).strict();

export type RewardRelease = z.infer<typeof RewardReleaseSchema>;
export type RewardBinding = z.infer<typeof RewardBindingSchema>;
export type RewardComposition = z.infer<typeof RewardCompositionSchema>;
export type BoundRewardResult = z.infer<typeof BoundRewardResultSchema>;
export type RewardBindingSource = z.infer<typeof RewardBindingSourceSchema>;
export type LearnedRewardRunner = (input: { reward: RewardRelease; task: TaskRecord; evidence: AttemptEvidence; signal?: AbortSignal }) => Promise<{ rawScore: number; passed: boolean; evidenceHashes: string[] }>;

export function createRewardRelease(input: z.input<typeof RewardReleaseContentSchema>): RewardRelease {
  assertBoundedTaskJson(input);
  const content = RewardReleaseContentSchema.parse(input);
  return RewardReleaseSchema.parse({ ...content, contentHash: contentHash(content) });
}

export function createRewardBinding(input: z.input<typeof RewardBindingContentSchema>, rewards: RewardRelease[]): RewardBinding {
  const content = RewardBindingContentSchema.parse(input);
  const binding = RewardBindingSchema.parse({ ...content, contentHash: contentHash(content) });
  resolveBoundRewards(binding, rewards);
  return binding;
}

export function resolveBoundRewards(input: RewardBinding, rewards: RewardRelease[]): Array<{ source: RewardBindingSource; reward: RewardRelease }> {
  const binding = RewardBindingSchema.parse(input);
  assertRewardHash(binding);
  return binding.sources.map((source) => {
    const reward = rewards.find((candidate) => candidate.id === source.reward.id && candidate.revision === source.reward.revision && candidate.contentHash === source.reward.contentHash);
    if (!reward) throw new LearningDomainError("reward_release_missing", 422, source.graderId);
    const parsed = RewardReleaseSchema.parse(reward);
    assertRewardHash(parsed);
    if (parsed.implementation.kind === "human" && source.role === "training") throw new LearningDomainError("human_reward_not_executable", 422, source.graderId);
    if (source.normalization.kind === "identity" && (parsed.rawScore.minimum < 0 || parsed.rawScore.maximum > 1)) throw new LearningDomainError("reward_normalization_required", 422, source.graderId);
    if (source.normalization.kind === "linear" && (source.normalization.minimum !== parsed.rawScore.minimum || source.normalization.maximum !== parsed.rawScore.maximum)) throw new LearningDomainError("reward_normalization_contract_mismatch", 422, source.graderId);
    return { source, reward: parsed };
  });
}

export function compileBoundGraders(binding: RewardBinding, rewards: RewardRelease[]): GraderSpec[] {
  return resolveBoundRewards(binding, rewards).map(({ source, reward }) => {
    if (reward.implementation.kind === "learned_model") throw new LearningDomainError("learned_reward_requires_model_execution_adapter");
    return compileSource(source, reward);
  });
}

export async function executeRewardBinding(input: {
  binding: RewardBinding;
  rewards: RewardRelease[];
  task: TaskRecord;
  evidence: AttemptEvidence;
  modelJudge?: ModelJudgeRunner;
  customVerifier?: CustomVerifierRunner;
  learnedReward?: LearnedRewardRunner;
  signal?: AbortSignal;
}): Promise<RewardComposition> {
  const resolved = resolveBoundRewards(input.binding, input.rewards);
  const results: BoundRewardResult[] = [];
  for (const { source, reward } of resolved) {
    input.signal?.throwIfAborted();
    const result: BoundRewardResult = { graderId: source.graderId, reward: source.reward, role: source.role, status: "unavailable", rawScore: null, normalizedScore: null, passed: null, evidenceHashes: [], message: null };
    try {
      if (reward.implementation.kind === "human") {
        result.status = "pending";
        result.message = "Human review is pending.";
      } else if (reward.implementation.kind === "learned_model") {
        if (!input.learnedReward) result.message = "Learned reward execution is not configured.";
        else {
          const scored = await input.learnedReward({ reward, task: input.task, evidence: input.evidence, signal: input.signal });
          Object.assign(result, { status: "scored", ...scored });
        }
      } else {
        const [evidence] = await gradeEvidence({ task: input.task, evidence: input.evidence, graders: [compileSource(source, reward)], modelJudge: input.modelJudge, customVerifier: input.customVerifier });
        if (!evidence) throw new LearningDomainError("reward_evidence_missing");
        Object.assign(result, { status: evidence.score === null ? "unavailable" : "scored", rawScore: evidence.score, passed: evidence.score === null ? null : evidence.passed, evidenceHashes: [evidence.contentHash], message: evidence.feedback.join("\n") });
      }
      if (result.status === "scored") {
        if (result.rawScore === null || !Number.isFinite(result.rawScore) || result.rawScore < reward.rawScore.minimum || result.rawScore > reward.rawScore.maximum) throw new LearningDomainError("reward_raw_score_outside_contract");
        const normalization = source.normalization;
        result.normalizedScore = normalization.kind === "identity" ? result.rawScore : (result.rawScore - normalization.minimum) / (normalization.maximum - normalization.minimum);
        if (normalization.kind === "linear" && normalization.direction === "lower") result.normalizedScore = 1 - result.normalizedScore;
      }
    } catch (error) {
      input.signal?.throwIfAborted();
      Object.assign(result, { status: "failed", rawScore: null, normalizedScore: null, passed: null, message: error instanceof Error ? error.message : "Reward execution failed." });
    }
    results.push(BoundRewardResultSchema.parse(result));
  }
  return composeBoundRewards({ binding: input.binding, taskHash: contentHash(input.task), outputHash: contentHash(input.evidence), results });
}

export function composeBoundRewards(input: { binding: RewardBinding; taskHash: string; outputHash: string; results: BoundRewardResult[] }): RewardComposition {
  const binding = RewardBindingSchema.parse(input.binding);
  assertRewardHash(binding);
  const results = input.results.map((result) => BoundRewardResultSchema.parse(result));
  if (results.length !== binding.sources.length || new Set(results.map((result) => result.graderId)).size !== results.length) throw new LearningDomainError("reward_result_set_incomplete");
  for (const source of binding.sources) {
    const result = results.find((candidate) => candidate.graderId === source.graderId);
    if (!result || contentHash(result.reward) !== contentHash(source.reward) || result.role !== source.role) throw new LearningDomainError("reward_result_binding_mismatch");
    if ((result.status === "scored") !== (result.rawScore !== null && result.normalizedScore !== null && result.passed !== null)) throw new LearningDomainError("reward_result_score_state_invalid");
    if (result.status !== "scored" && (result.rawScore !== null || result.normalizedScore !== null || result.passed !== null)) throw new LearningDomainError("unscorable_reward_contains_score");
    if (result.status === "scored") {
      const transform = source.normalization;
      const normalized = transform.kind === "identity" ? result.rawScore! : (result.rawScore! - transform.minimum) / (transform.maximum - transform.minimum);
      const expected = transform.kind === "linear" && transform.direction === "lower" ? 1 - normalized : normalized;
      if (Math.abs(expected - result.normalizedScore!) > 1e-12) throw new LearningDomainError("reward_normalization_mismatch");
    }
  }
  const content = RewardCompositionContentSchema.parse({
    schemaVersion: "openpond.rewardComposition.v1",
    binding: { id: binding.id, revision: binding.revision, contentHash: binding.contentHash },
    taskHash: input.taskHash,
    outputHash: input.outputHash,
    results,
    training: aggregate("training"),
    evaluation: aggregate("evaluation"),
  });
  return RewardCompositionSchema.parse({ ...content, contentHash: contentHash(content) });

  function aggregate(role: "training" | "evaluation"): RewardComposition["training"] {
    const selected = binding.sources.filter((source) => source.role === role).map((source) => ({ source, result: results.find((candidate) => candidate.graderId === source.graderId)! }));
    if (!selected.length) return { status: "not_configured", score: null, passed: null };
    if (selected.some(({ source, result }) => source.required && result.status !== "scored")) return { status: "unscorable", score: null, passed: null };
    const scored = selected.filter(({ result }) => result.status === "scored");
    const weight = scored.reduce((sum, { source }) => sum + source.weight, 0);
    if (weight === 0) return { status: "unscorable", score: null, passed: null };
    const gated = scored.some(({ source, result }) => source.hardGate && !result.passed);
    return { status: "scored", score: gated ? 0 : scored.reduce((sum, { source, result }) => sum + source.weight * result.normalizedScore!, 0) / weight, passed: !gated && scored.every(({ result }) => result.passed) };
  }
}

export function assertRewardHash(value: { contentHash: string }): void {
  assertBoundedTaskJson(value);
  if (contentHash(withoutRewardHash(value)) !== value.contentHash) throw new LearningDomainError("reward_content_hash_mismatch");
}
function withoutRewardHash<T extends { contentHash: string }>(value: T): Omit<T, "contentHash"> { const { contentHash: _hash, ...content } = value; return content; }
function compileSource(source: RewardBindingSource, reward: RewardRelease): GraderSpec {
  if (reward.implementation.kind === "learned_model") throw new LearningDomainError("learned_reward_requires_model_execution_adapter");
  return GraderSpecSchema.parse({ ...reward.implementation, id: source.graderId, version: String(reward.revision), weight: source.weight, hardGate: source.hardGate, rewardEligible: source.role === "training", privileged: source.privileged });
}
