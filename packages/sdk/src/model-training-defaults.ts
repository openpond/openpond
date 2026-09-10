import { contentHash } from "@openpond/harness";
import { compileBoundGraders } from "@openpond/evals/rewards";
import { validateModelTasksetPackage } from "./model-taskset-derivation.js";
import { ModelProjectTrainingSetupSchema, type ModelProjectTrainingSetup } from "./model-projects.js";
import { validateTasksetPackage } from "./taskset-package-contracts.js";

/** Saved defaults do not authorize execution. The Run review still owns the
 * budget, runtime admission and exact training/evaluation population checks. */
export function prepareModelTrainingDefaults(input: {
  setup: ModelProjectTrainingSetup;
  package: unknown;
}): ModelProjectTrainingSetup {
  const setup = ModelProjectTrainingSetupSchema.parse(input.setup);
  const portable = typeof input.package === "object" && input.package !== null
    && "schemaVersion" in input.package && input.package.schemaVersion === "openpond.tasksetPackage.v1"
    ? validateTasksetPackage(input.package) : null;
  const bound = portable ? null : validateModelTasksetPackage(input.package);
  const source = portable ?? bound!;
  const ref = setup.tasksetRef;
  const selected = ref && ref.revision === source.taskset.revision && (portable
    ? (ref.id === portable.taskset.id && ref.contentHash === portable.taskset.contentHash)
      || (ref.id === portable.taskset.metadata.sourceTasksetId && ref.contentHash === portable.taskset.metadata.sourceTasksetHash)
    : ref.id === source.taskset.id);
  if (!selected) return setup;
  if (!setup.evaluationTasksetRef && source.taskset.tasks.some(task => task.split === "frozen_eval" || task.split === "validation")) {
    setup.evaluationTasksetRef = setup.tasksetRef;
  }
  const base = setup.baseModel;
  if (setup.method !== "grpo" || setup.recipe || !base?.revision
    || !base.tokenizerRevision || !base.chatTemplateHash) return setup;
  const training = source.taskset.tasks.filter(task => task.split === "train");
  const graders = portable ? portable.taskset.graders : compileBoundGraders(bound!.rewardBinding, bound!.rewards);
  const grader = graders.find(candidate => candidate.rewardEligible && candidate.weight > 0);
  const environment = portable?.environment ?? bound?.executionResources?.environment ?? bound?.execution?.environment;
  if (!training.length || !grader || !environment) return setup;
  const groupSize = 8;
  const maxSteps = 8;
  return ModelProjectTrainingSetupSchema.parse({
    ...setup,
    recipe: {
      schemaVersion: "openpond.rftRecipe.v1", method: "grpo", parameterization: "lora",
      baseModel: { id: base.modelId, revision: base.revision,
        tokenizerRevision: base.tokenizerRevision, chatTemplateHash: base.chatTemplateHash },
      dataset: { trainSplit: "train", validationSplit: source.taskset.tasks.some(task => task.split === "frozen_eval") ? "frozen_eval" : "validation",
        maxPromptTokens: 4_096, maxExamples: Math.min(1_000, training.length), selectionStrategy: "stable_hash_top_n" },
      lora: { rank: 2 },
      rollout: { groupSize, concurrency: 4,
        maxTurns: source.taskset.environment.kind === "text" ? 1 : 15,
        maxOutputTokens: 1_024, temperature: 0.8, topP: 0.95, seed: 17 },
      optimizer: { learningRate: 0.0001, maxSteps, clipRange: 0.2, iterations: 2,
        microbatchSize: 1, gradientAccumulationSteps: groupSize, advantageEpsilon: 1e-8,
        adamw: { name: "adamw", weightDecay: 0, beta1: 0.9, beta2: 0.999, epsilon: 1e-8 } },
      loss: { method: "grpo", klBeta: 0.01 },
      reward: { graderId: grader.id, graderHash: contentHash(graders),
        environmentId: environment.id, environmentVersion: String(environment.revision),
        toolContractHash: contentHash(source.taskset.tools), learnedPreference: null },
      resourceLimits: { wallTimeMs: 66 * 60 * 1_000, maxRollouts: maxSteps * groupSize, maxPayloadBytes: 1_000_000 },
      policyOptimization: null,
    },
  });
}
