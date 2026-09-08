import { z } from "zod";
import { compileBoundGraders, RewardBindingSchema, RewardReleaseSchema } from "@openpond/evals/rewards";
import { canonicalSha256 } from "./protocol.js";

const GradersSchema = z.array(z.object({ id: z.string().trim().min(1) }).catchall(z.unknown())).min(1).max(1_000);
const RewardExecutionSchema = z.object({
  binding: RewardBindingSchema,
  rewards: z.array(RewardReleaseSchema).min(1).max(100),
}).strict();

/**
 * The grader reference identifies the entire executed set, including order and
 * configuration. A bound plan additionally identifies its immutable composer,
 * whose sources pin roles, normalization, gates and required-score semantics.
 * Callers must obtain these inputs from their verified immutable bundle.
 */
export async function deterministicTrainingRewardSource(input: {
  graders: unknown;
  rewardExecution?: unknown;
}) {
  const execution = input.rewardExecution ? RewardExecutionSchema.parse(input.rewardExecution) : null;
  const graders = GradersSchema.parse(execution
    ? compileBoundGraders(execution.binding, execution.rewards)
    : input.graders);
  if (new Set(graders.map(grader => grader.id)).size !== graders.length) {
    throw new Error("Training grader identities must be unique.");
  }
  const hash = await canonicalSha256({ schemaVersion: "openpond.trainingGraderSet.v1", graders });
  return {
    kind: "deterministic" as const,
    grader: { id: `training-graders-${hash.slice(0, 32)}`, contentHash: hash },
    composer: execution ? { id: execution.binding.id, contentHash: execution.binding.contentHash } : null,
  };
}
