import {
  TrainingPlanSchema,
  type Taskset,
  type TrainingDestinationId,
  type TrainingPlan,
  type TrainingRecipe,
  type ImmutableReleaseRef,
} from "@openpond/contracts";
import { contentHash } from "@openpond/taskset-sdk";

export function createTrainingPlan(input: {
  modelId: string;
  taskset: Taskset;
  destinationId: TrainingDestinationId;
  recipe: TrainingRecipe;
  environmentPlacement?: "local" | "remote";
  exportApproved?: boolean;
  retentionDays?: number | null;
  region?: string | null;
  harnessRelease?: ImmutableReleaseRef | null;
  modelImprovementQualification?: ImmutableReleaseRef | null;
}): TrainingPlan {
  const createdAt = new Date().toISOString();
  const environmentPlacement = input.destinationId === "openpond_managed"
    ? (input.environmentPlacement ?? "local")
    : ("local" as const);
  const id = `training_plan_${contentHash([input.modelId, input.taskset.contentHash, input.destinationId, environmentPlacement, input.recipe, input.modelImprovementQualification ?? null]).slice(0, 24)}`;
  const compatibility = { schemaVersion: "openpond.trainingCompatibility.v1" as const, compatible: false, destinationId: input.destinationId, tasksetId: input.taskset.id, recipeMethod: input.recipe.method, issues: [{ code: "compatibility_pending", severity: "error" as const, path: null, message: "Destination compatibility has not been checked." }], checkedAt: createdAt };
  const draft = { schemaVersion: "openpond.trainingPlan.v1" as const, id, modelId: input.modelId, tasksetId: input.taskset.id, tasksetHash: input.taskset.contentHash, harnessRelease: input.harnessRelease ?? null, modelImprovementQualification: input.modelImprovementQualification ?? null, destinationId: input.destinationId, recipe: input.recipe, environmentPlacement, compatibility, dataPolicy: { exportApproved: input.exportApproved ?? false, approvedSourceIds: input.taskset.sourceRefs.map((source) => source.id), retentionDays: input.retentionDays ?? null, region: input.region ?? null }, estimatedCostUsd: input.destinationId === "local_cpu_fixture" ? 0 : null, createdAt, contentHash: "00000000" };
  const parsed = TrainingPlanSchema.parse(draft);
  return TrainingPlanSchema.parse({ ...parsed, contentHash: contentHash({ ...parsed, contentHash: "" }) });
}
