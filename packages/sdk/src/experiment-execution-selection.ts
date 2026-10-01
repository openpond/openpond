import type { ModelTasksetRunRequest } from "./model-taskset-runs-contracts.js";

/** Resolve presentation from the configuration that actually executes. These
 * modes never inherit a selected chat session or a mutable desktop preference. */
export function experimentExecutionSelection(policy: ModelTasksetRunRequest["policy"]) {
  if (policy.kind === "fixture") return { mode: "fixture" as const };
  if (policy.kind === "hosted_harness") return {
    mode: "model_harness_profile" as const,
    modelId: policy.modelId,
    harnessRelease: policy.source.harnessRelease,
    profile: { repositoryId: policy.profileRepositoryId, id: policy.source.profileId,
      revision: policy.source.sourceRevision, target: policy.source.target },
  };
  return policy.harness ? {
    mode: "model_harness" as const, modelId: policy.modelId, harness: policy.harness,
  } : { mode: "model" as const, modelId: policy.modelId };
}
