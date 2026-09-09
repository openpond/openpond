import { LearningDomainError } from "@openpond/evals/learning";
import { contentHash } from "@openpond/harness";

import type { HostedModelProjectSummary } from "./model-projects.js";

/** Bind a reviewed hosted Model configuration before asynchronous preparation.
 * Keep the established recipe identity: its id binds the whole Model revision,
 * including Harness and retention selections, while its hash binds the recipe.
 * Callers must obtain the summary from the authenticated Model API. */
export function hostedLearningPolicyReferences(project: HostedModelProjectSummary) {
  const setup = project.trainingSetup;
  const base = setup.baseModel ?? project.defaultBaseModel;
  if (!setup.recipe || !base || !setup.evaluationTasksetRef) {
    throw new LearningDomainError("learning_model_configuration_incomplete", 422,
      "Select a training recipe, starting model and retained evaluation before enabling hosted learning.");
  }
  return {
    recipe: { id: `model-recipe-${project.etag}`, contentHash: contentHash(setup.recipe) },
    trainingParent: { id: base.modelId, contentHash: contentHash(base) },
    retentionEvaluation: { id: setup.evaluationTasksetRef.id, contentHash: setup.evaluationTasksetRef.contentHash },
  };
}
