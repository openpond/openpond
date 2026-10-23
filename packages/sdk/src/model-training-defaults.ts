import { contentHash } from "@openpond/harness";
import { compileBoundGraders } from "@openpond/evals/rewards";
import { validateModelTasksetPackage } from "./model-taskset-derivation.js";
import { ModelProjectTrainingSetupSchema, type ModelProjectTrainingSetup } from "./model-projects.js";

function fields(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

/** Editable GRPO defaults are available before tasks/base/grader are bound.
 * This draft never authorizes execution; package preparation binds those inputs. */
export function createModelTrainingRecipeDefaults(saved?: ModelProjectTrainingSetup["recipe"]): NonNullable<ModelProjectTrainingSetup["recipe"]> {
  const defaults = {
    schemaVersion: "openpond.rftRecipe.v1", method: "grpo" as const, parameterization: "lora" as const,
    lora: { rank: 2 },
    rollout: { groupSize: 8, concurrency: 4, maxOutputTokens: 1_024, temperature: 0.8, topP: 0.95, seed: 17 },
    optimizer: { learningRate: 0.0001, maxSteps: 8, clipRange: 0.2, iterations: 2,
      microbatchSize: 1, gradientAccumulationSteps: 8, advantageEpsilon: 1e-8,
      adamw: { name: "adamw", weightDecay: 0, beta1: 0.9, beta2: 0.999, epsilon: 1e-8 } },
    loss: { method: "grpo", klBeta: 0.01 },
    resourceLimits: { wallTimeMs: 66 * 60 * 1_000, maxRollouts: 64, maxPayloadBytes: 1_000_000 },
    policyOptimization: null,
  };
  return {
    ...defaults, ...saved,
    lora: { ...defaults.lora, ...fields(saved?.lora) },
    rollout: { ...defaults.rollout, ...fields(saved?.rollout) },
    optimizer: { ...defaults.optimizer, ...fields(saved?.optimizer),
      adamw: { ...defaults.optimizer.adamw, ...fields(fields(saved?.optimizer).adamw) } },
    loss: { ...defaults.loss, ...fields(saved?.loss) },
    resourceLimits: { ...defaults.resourceLimits, ...fields(saved?.resourceLimits) },
  };
}

/** Changing source inputs invalidates only their bindings, preserving the
 * caller's optimizer, rollout, adapter, loss and budget settings. */
export function rebindModelTrainingRecipe(saved: ModelProjectTrainingSetup["recipe"]) {
  const { baseModel: _base, reward: _reward, policyOptimization: _compiled, ...recipe } = createModelTrainingRecipeDefaults(saved);
  // Split names and the derived source population belong to the new package.
  // Retain authoring controls such as prompt length/selection strategy.
  const { trainSplit: _train, validationSplit: _validation, maxExamples: _population, ...dataset } = fields(recipe.dataset);
  return { ...recipe, dataset, policyOptimization: null };
}
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
  if (setup.method !== "grpo" || (setup.recipe && setup.recipe.method !== "grpo") || !base?.revision
    || !base.tokenizerRevision || !base.chatTemplateHash) return setup;
  // Existing bound recipes retain their exact explicit settings and the
  // compiler's absent-field semantics. Only an unbound authoring draft needs
  // package-derived defaults; source changes explicitly invalidate bindings.
  if (setup.recipe?.baseModel && setup.recipe.reward && setup.recipe.dataset) return setup;
  const training = source.taskset.tasks.filter(task => task.split === "train");
  const graders = portable ? portable.taskset.graders : compileBoundGraders(bound!.rewardBinding, bound!.rewards);
  const grader = graders.find(candidate => candidate.rewardEligible && candidate.weight > 0);
  const environment = portable?.environment ?? bound?.executionResources?.environment ?? bound?.execution?.environment;
  if (!training.length || !grader || !environment) return setup;
  const recipe = createModelTrainingRecipeDefaults(setup.recipe);
  return ModelProjectTrainingSetupSchema.parse({
    ...setup,
    recipe: {
      ...recipe,
      baseModel: { id: base.modelId, revision: base.revision,
        tokenizerRevision: base.tokenizerRevision, chatTemplateHash: base.chatTemplateHash },
      dataset: { trainSplit: "train", validationSplit: source.taskset.tasks.some(task => task.split === "frozen_eval") ? "frozen_eval" : "validation",
        maxPromptTokens: 4_096, maxExamples: Math.min(1_000, training.length), selectionStrategy: "stable_hash_top_n", ...fields(recipe.dataset) },
      rollout: { maxTurns: source.taskset.environment.kind === "text" ? 1 : 15, ...fields(recipe.rollout) },
      reward: { graderId: grader.id, graderHash: contentHash(graders),
        environmentId: environment.id, environmentVersion: String(environment.revision),
        toolContractHash: contentHash(source.taskset.tools), learnedPreference: fields(recipe.reward).learnedPreference ?? null },
    },
  });
}
