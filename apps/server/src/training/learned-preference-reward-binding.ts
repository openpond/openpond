import type {
  LearnedPreferenceRewardBinding,
  RewardModelVersion,
} from "@openpond/contracts";
import { LearnedPreferenceRewardBindingSchema } from "@openpond/contracts";
import type { RewardModelQualificationReport } from "@openpond/evals";

/**
 * Produces the sole policy-facing representation of a qualified reward model.
 * It deliberately derives checkpoint identity from the published Version so a
 * caller cannot combine a familiar model ID with different scorer weights.
 */
export function bindLearnedPreferenceReward(input: {
  version: RewardModelVersion;
  qualificationReport: RewardModelQualificationReport;
  rewardComposerRelease: { id: string; contentHash: string };
}): LearnedPreferenceRewardBinding {
  if (input.version.status !== "available") {
    throw new Error("A Policy Run requires an available Reward Model Version.");
  }
  if (!input.version.runtime) {
    throw new Error("A Policy Run requires a Reward Model Version with a pinned scorer runtime.");
  }
  const report = input.qualificationReport;
  if (!report.passed) {
    throw new Error("A Policy Run requires a passing Reward Model qualification report.");
  }
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
  if (
    report.kind === "synthetic_smoke" && report.productionRewardEligible
  ) {
    throw new Error("Synthetic Reward Model qualification cannot be production eligible.");
  }
  return LearnedPreferenceRewardBindingSchema.parse({
    rewardModelVersion: { id: input.version.id, contentHash: input.version.contentHash },
    qualificationReport: { id: report.id, contentHash: report.contentHash },
    checkpoint: input.version.artifacts.checkpoint,
    runtime: input.version.runtime,
    processorRelease: input.version.artifacts.processorRelease,
    rewardComposerRelease: input.rewardComposerRelease,
    qualificationKind: report.kind,
  });
}
