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
  const recipe = input.plan.recipe;
  if (recipe.method === "sft") {
    const maxSequenceLength = recipe.dataset.maxSequenceLength;
    const oversized = input.taskset.tasks.filter((task) => task.split === recipe.dataset.trainSplit).filter((task) => estimatedRenderedTokens(task) > maxSequenceLength);
    if (oversized.length) issues.push({ code: "training_examples_truncated", severity: "error", path: "recipe.dataset.maxSequenceLength", message: `${oversized.length} training example${oversized.length === 1 ? " is" : "s are"} likely to be truncated at ${maxSequenceLength} tokens. Increase the sequence length or shorten the examples before training.` });
    const trainCount = input.taskset.tasks.filter((task) => task.split === recipe.dataset.trainSplit).length;
    if (trainCount < 8) issues.push({ code: "training_dataset_small", severity: "warning", path: "taskset.tasks", message: `${trainCount} training example${trainCount === 1 ? " is" : "s are"} sufficient for a pipeline test, not evidence of useful model quality.` });
  }
  return TrainingCompatibilityReportSchema.parse({ schemaVersion: "openpond.trainingCompatibility.v1", compatible: !issues.some((issue) => issue.severity === "error"), destinationId: input.plan.destinationId, tasksetId: input.taskset.id, recipeMethod: input.plan.recipe.method, issues, checkedAt: new Date().toISOString() });
}

function estimatedRenderedTokens(task: Taskset["tasks"][number]): number {
  const prompt = typeof task.input.prompt === "string" ? task.input.prompt : JSON.stringify(task.input);
  const expected = typeof task.expectedOutput?.text === "string" ? task.expectedOutput.text : task.expectedOutput ? JSON.stringify(task.expectedOutput) : "";
  return 24 + Math.ceil((prompt.length + expected.length) / 4);
}
