import type { ModelArtifactLineage, Taskset, TrainingArtifact, TrainingJob, TrainingPlan } from "@openpond/contracts";
import { destinationLabel, formatDateTime, formatDuration, modelName, statusLabel, tasksetMethod, trainingRunMethodLabel } from "./training-model-data";

export type TrainingSidebarSummary = {
  taskset: Taskset;
  plan: TrainingPlan | null;
  job: TrainingJob | null;
  lineage: ModelArtifactLineage | null;
  artifacts: TrainingArtifact[];
};

export function TrainingRunSidebarSummary({ summary }: { summary: TrainingSidebarSummary }) {
  const method = tasksetMethod(summary.taskset);
  const examples = summary.taskset.learningSignals.demonstrations.filter((demonstration) => demonstration.approved).length;
  const tests = summary.taskset.tasks.filter((task) => task.split === "frozen_eval").length;
  const recipe = summary.plan?.recipe.method === "sft" ? summary.plan.recipe : null;
  const runMethod = trainingRunMethodLabel(summary.taskset, summary.plan);
  return <div className="training-sidebar-summary"><header><h2>{modelName(summary.taskset.name, method)}</h2><span>{summary.job ? statusLabel(summary.job.status) : summary.taskset.readiness?.ready ? "Ready to train" : "Needs review"}</span></header><section><h3>Run</h3><dl><Fact label="Primary recommendation" value={method.toUpperCase()}/><Fact label="Training stage" value={runMethod}/><Fact label="Base model" value={recipe?.baseModel.id ?? "Not selected"}/><Fact label="Compute" value={summary.plan ? destinationLabel(summary.plan.destinationId) : "Not selected"}/><Fact label="Started" value={formatDateTime(summary.job?.startedAt ?? null)}/><Fact label="Duration" value={formatDuration(summary.job?.startedAt ?? null, summary.job?.completedAt ?? null)}/></dl></section><section><h3>Data</h3><dl><Fact label="Training examples" value={String(examples)}/><Fact label="Test examples" value={String(tests)}/><Fact label="Chats" value={String(summary.taskset.sourceRefs.length)}/></dl></section>{recipe ? <section><h3>Recipe</h3><dl><Fact label="LoRA rank" value={String(recipe.lora.rank)}/><Fact label="Learning rate" value={String(recipe.optimizer.learningRate)}/><Fact label="Steps" value={String(recipe.optimizer.maxSteps)}/><Fact label="Sequence length" value={String(recipe.dataset.maxSequenceLength)}/></dl></section> : null}<section><h3>Result</h3><dl><Fact label="Adapter" value={summary.lineage ? `${runMethod} ready` : "Not created"}/><Fact label="Evaluation" value={summary.lineage?.frozenEvaluationArtifactId ? "Completed" : "Not completed"}/><Fact label="Artifacts" value={String(summary.artifacts.length)}/></dl></section></div>;
}

function Fact({ label, value }: { label: string; value: string }) { return <div><dt>{label}</dt><dd>{value}</dd></div>; }
