import type {
  LearnedPreferenceRewardBinding,
  RewardModelVersion,
} from "@openpond/contracts";
import { LearnedPreferenceRewardBindingSchema } from "@openpond/contracts";
import type { RewardModelQualificationReport } from "@openpond/evals";

export type LearnedScorerRelease = Pick<
  RewardModelVersion,
  "id" | "contentHash" | "status" | "runtime" | "artifacts"
>;

/**
 * Produces the policy-facing representation of an immutable learned scorer.
 * It deliberately derives checkpoint identity from the published Version so a
 * caller cannot combine a familiar model ID with different scorer weights.
 * Qualification is optional Model Project evidence, never an execution gate.
 */
export function bindLearnedPreferenceReward(input: {
  version: LearnedScorerRelease;
  qualificationReport?: RewardModelQualificationReport | null;
  rewardComposerRelease: { id: string; contentHash: string };
  executionReceipt: { id: string; contentHash: string };
}): LearnedPreferenceRewardBinding {
  if (input.version.status !== "available") {
    throw new Error("A Policy Run requires an available Reward Model Version.");
  }
  if (!input.version.runtime) {
    throw new Error("A Policy Run requires a Reward Model Version with a pinned scorer runtime.");
  }
  const report = input.qualificationReport ?? null;
  if (report) {
    if (
      report.rewardModelVersion.id !== input.version.id ||
      report.rewardModelVersion.contentHash !== input.version.contentHash
    ) {
      throw new Error("Reward Model qualification report does not pin the selected Reward Model Version.");
    }
    if (
      report.processorRelease.id !== input.version.artifacts.processorRelease.id ||
      report.processorRelease.contentHash !== input.version.artifacts.processorRelease.contentHash
    ) {
      throw new Error("Reward Model qualification report does not pin the selected processor release.");
    }
  }
  return LearnedPreferenceRewardBindingSchema.parse({
    rewardModelVersion: { id: input.version.id, contentHash: input.version.contentHash },
    qualificationReport: report ? { id: report.id, contentHash: report.contentHash } : null,
    evaluationReferences: report ? [{ id: report.id, contentHash: report.contentHash }] : [],
    checkpoint: input.version.artifacts.checkpoint,
    runtime: input.version.runtime,
    processorRelease: input.version.artifacts.processorRelease,
    rewardComposerRelease: input.rewardComposerRelease,
    executionReceipt: input.executionReceipt,
  });
}
