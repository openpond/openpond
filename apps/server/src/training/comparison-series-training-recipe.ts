import {
  TrainingRecipeSchema,
  type ModelComparisonSeriesEntry,
  type TrainingRecipe,
} from "@openpond/contracts";

import type { SqliteStore } from "../store/store.js";

export async function comparisonSeriesTrainingRecipe(input: {
  store: SqliteStore;
  recipe: unknown;
  entry: ModelComparisonSeriesEntry | null;
}): Promise<TrainingRecipe> {
  const recipe = TrainingRecipeSchema.parse(input.recipe);
  if (!input.entry) return recipe;
  if (recipe.schemaVersion !== "openpond.rftRecipe.v1" || recipe.method !== "grpo") {
    throw new Error("Comparison Series execution requires a GRPO residual-LoRA recipe.");
  }

  const ranked = {
    ...recipe,
    lora: { ...recipe.lora, rank: input.entry.trainableRank },
  };
  if (input.entry.parent.kind === "base_model") {
    const { continuation: _continuation, ...fresh } = ranked;
    return TrainingRecipeSchema.parse(fresh);
  }

  const parentVersion = await input.store.getModelVersion(input.entry.parent.id);
  if (
    !parentVersion
    || parentVersion.contentHash !== input.entry.parent.contentHash
    || !parentVersion.artifactLineageId
  ) {
    throw new Error("The Comparison Series parent Model Version is unavailable or changed.");
  }
  const lineage = await input.store.getModelArtifactLineage(parentVersion.artifactLineageId);
  if (!lineage) {
    throw new Error("The Comparison Series parent artifact lineage is unavailable.");
  }
  const artifact = await input.store.getTrainingArtifact(lineage.artifactId);
  const outputMetadata = record(artifact?.metadata.managedRlOutputMetadata);
  const jobId = nonempty(artifact?.metadata.managedRlJobId);
  const artifactId = nonempty(artifact?.metadata.managedRlOutputId);
  const checkpointId = nonempty(outputMetadata.checkpointId);
  if (
    !artifact
    || artifact.metadata.provider !== "sandbox"
    || artifact.metadata.managedRlCandidate !== true
    || !jobId
    || !artifactId
    || !checkpointId
  ) {
    throw new Error("The Comparison Series parent is not an exact Sandbox continuation artifact.");
  }
  const parentArtifact = { id: artifactId, contentHash: artifact.sha256 };
  return TrainingRecipeSchema.parse({
    ...ranked,
    continuation: {
      schemaVersion: "openpond.crossJobContinuationRequest.v1",
      parentArtifact,
      sourceArtifact: {
        jobId,
        artifactId,
        checkpointId,
        contentHash: artifact.sha256,
      },
      optimizerMode: "reset",
    },
  });
}

function nonempty(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value : null;
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}
