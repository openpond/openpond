import { contentHash } from "@openpond/harness";
import { sameLearningRef } from "@openpond/evals/learning";
import { ModelTasksetAuthoringSchema } from "./model-taskset-authoring-contracts.js";

export function modelAuthoredTasksetId(lineage: { owner: unknown; root: unknown }) {
  return `model-authored-taskset-${contentHash({ owner: lineage.owner, root: lineage.root })}`;
}

/** Ownership metadata must describe this exact immutable revision. */
export function assertModelTasksetAuthoring(taskset: { id: string; revision: number; metadata: Record<string, unknown> }) {
  if (taskset.metadata.modelTasksetAuthoring === undefined) return null;
  const lineage = ModelTasksetAuthoringSchema.parse(taskset.metadata.modelTasksetAuthoring);
  if (taskset.id !== modelAuthoredTasksetId(lineage)
    || (taskset.revision === 1 ? !sameLearningRef(lineage.parent, lineage.root)
      : lineage.parent.id !== taskset.id || lineage.parent.revision !== taskset.revision - 1)) {
    throw new Error("Authored Taskset revision differs from its ownership lineage.");
  }
  return lineage;
}
