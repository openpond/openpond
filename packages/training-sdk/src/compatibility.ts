import {
  TrainingCompatibilityReportSchema,
  type Taskset,
  type TrainingDestinationCapabilities,
  type TrainingPlan,
} from "@openpond/contracts";

export function validateTrainingCompatibility(input: {
  taskset: Taskset;
  plan: TrainingPlan;
  capabilities: TrainingDestinationCapabilities;
}) {
  const issues: Array<{ code: string; severity: "warning" | "error"; path: string | null; message: string }> = [];
  if (!input.capabilities.available) issues.push({ code: "destination_unavailable", severity: "error", path: "destinationId", message: input.capabilities.unavailableReason ?? "Destination is unavailable." });
  if (!input.capabilities.methods.includes(input.plan.recipe.method)) issues.push({ code: "method_unsupported", severity: "error", path: "recipe.method", message: `${input.plan.destinationId} does not support ${input.plan.recipe.method}.` });
  if (!input.capabilities.parameterizations.includes(input.plan.recipe.parameterization)) issues.push({ code: "parameterization_unsupported", severity: "error", path: "recipe.parameterization", message: `${input.plan.destinationId} does not support ${input.plan.recipe.parameterization}.` });
  if (!input.taskset.capabilities.compatibleMethods.includes(input.plan.recipe.method)) issues.push({ code: "taskset_method_incompatible", severity: "error", path: "taskset.capabilities.compatibleMethods", message: `Taskset does not declare ${input.plan.recipe.method} compatibility.` });
  if (input.capabilities.modelAllowlist.length && !input.capabilities.modelAllowlist.includes(input.plan.recipe.method === "sft" ? input.plan.recipe.baseModel.id : "")) issues.push({ code: "model_unsupported", severity: "error", path: "recipe.baseModel", message: "Base model is not in the destination allowlist." });
  if (input.plan.recipe.method !== "sft") issues.push({ code: "recipe_not_executable", severity: "error", path: "recipe.method", message: `OpenPond has no proven executable ${input.plan.recipe.method} recipe contract yet.` });
  return TrainingCompatibilityReportSchema.parse({ schemaVersion: "openpond.trainingCompatibility.v1", compatible: !issues.some((issue) => issue.severity === "error"), destinationId: input.plan.destinationId, tasksetId: input.taskset.id, recipeMethod: input.plan.recipe.method, issues, checkedAt: new Date().toISOString() });
}
