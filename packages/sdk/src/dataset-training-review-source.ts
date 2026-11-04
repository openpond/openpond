import { learningRef, LearningJsonObjectSchema, taskBatchPackageMetadata } from "@openpond/evals/learning";
import { DatasetTrainingReviewSourceSchema } from "./dataset-training-review-contracts.js";
import { resolveTasksetPackageInstructions, validateTasksetPackage, type TasksetPackage } from "./taskset-package-contracts.js";

/** Pure inspection after the caller obtains an authorized immutable package.
 * This is not execution admission or authorization to share it. */
export function inspectDatasetTrainingReviewPackage(raw: TasksetPackage) {
  const value = validateTasksetPackage(raw);
  const parent = value.learningResources ? taskBatchPackageMetadata(value.taskset) : null;
  const definition = parent?.definition ?? value.modelResources?.taskDefinition;
  const binding = parent?.binding ?? value.modelResources?.rewardBinding;
  const instructions = definition?.instructions ?? resolveTasksetPackageInstructions(value);
  const contract = value.taskset.metadata.tasksetOutputContract;
  const ordinaryOutput = contract && typeof contract === "object" && !Array.isArray(contract)
    && "mode" in contract && contract.mode === "structured_json" && "jsonSchema" in contract
    ? LearningJsonObjectSchema.parse(contract.jsonSchema) : null;
  const outputSchema = definition?.outputSchema ?? ordinaryOutput;
  return DatasetTrainingReviewSourceSchema.parse({
    schemaVersion: "openpond.datasetTrainingReviewSource.v1", dataset: learningRef(value.taskset),
    packageHash: value.contentHash, taskCount: value.taskset.tasks.length,
    definition: { name: definition?.name ?? value.taskset.id,
      ...(instructions?.trim() ? { instructions } : {}),
      ...(definition ? { inputSchema: definition.inputSchema } : {}),
      ...(outputSchema ? { outputSchema } : {}),
      ...(definition?.requiredOutputs ? { requiredOutputs: definition.requiredOutputs } : {}),
    },
    rewardBinding: binding ? learningRef(binding) : null,
    hasParentTargets: value.learningResources?.decisions.some(decision => decision.approvedTarget !== null) ?? false,
  });
}
