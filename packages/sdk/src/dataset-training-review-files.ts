import { contentHash } from "@openpond/harness";
import { LearningDomainError } from "@openpond/evals/learning";
import { validateTasksetPackage, type TasksetPackage } from "./taskset-package-contracts.js";
import { resolveTasksetPackageExecution } from "./taskset-package-execution.js";

/** The original package stays private. Share only selected task inputs/output
 * schemas and declared environment dependencies. New evidence gets regenerated
 * evaluator context; other tasks' context and the old declaration stay private.
 * Reward assets are imported through their own graph. */
export function datasetTrainingReviewFiles(value: TasksetPackage, taskIds: string[] | null) {
  const parent = validateTasksetPackage(value);
  const selected = taskIds ? new Set(taskIds) : null;
  const tasks = parent.taskset.tasks.filter(task => !selected || selected.has(task.id));
  if (!tasks.length || selected && tasks.length !== selected.size)
    throw new LearningDomainError("dataset_review_selection_mismatch", 409);
  const references = tasks.flatMap(task => [...task.artifactRefs,
    ...(task.requiredOutputs ?? []).flatMap(output => output.schemaRef ? [output.schemaRef] : []),
  ]);
  const execution = resolveTasksetPackageExecution(parent);
  references.push(...[parent.environment.actionSchemaRef, parent.environment.observationSchemaRef,
    parent.environment.stateSchemaRef, execution?.execution.javascript.module].flatMap(ref => ref ? [ref] : []));
  const files = new Map<string, TasksetPackage["files"][number]>();
  for (const ref of references) {
    const file = parent.files.find(item => item.asset.id === ref.id);
    if (!file || contentHash(file.asset) !== contentHash(ref))
      throw new LearningDomainError("dataset_review_asset_mismatch", 409);
    files.set(file.asset.id, file);
  }
  for (const declarations of [parent.taskset.metadata.environmentResources, parent.environment.metadata.resources]) {
    if (declarations === undefined) continue;
    if (!Array.isArray(declarations)) throw new LearningDomainError("dataset_review_environment_resources_invalid", 422);
    for (const declaration of declarations) {
      if (!declaration || typeof declaration !== "object" || !("path" in declaration))
        throw new LearningDomainError("dataset_review_environment_resources_invalid", 422);
      const matches = parent.files.filter(file => file.asset.path === declaration.path);
      if (matches.length !== 1) throw new LearningDomainError("dataset_review_environment_resource_ambiguous", 422);
      files.set(matches[0]!.asset.id, matches[0]!);
    }
  }
  return [...files.values()];
}
