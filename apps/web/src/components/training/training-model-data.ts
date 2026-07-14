import type { ModelArtifactLineage, Taskset, TrainingArtifact, TrainingJob, TrainingPlan, TrainingStateResponse } from "@openpond/contracts";

export type TrainingModelRow = {
  taskset: Taskset;
  name: string;
  method: string;
  latestPlan: TrainingPlan | null;
  latestJob: TrainingJob | null;
  localModel: ModelArtifactLineage | null;
  runCount: number;
  status: string;
  updatedAt: string;
};

export function trainingModelRows(state: TrainingStateResponse | null): TrainingModelRow[] {
  if (!state) return [];
  const planById = new Map(state.plans.map((plan) => [plan.id, plan]));
  return state.tasksets.map((taskset) => {
    const plans = state.plans.filter((plan) => plan.tasksetId === taskset.id);
    const planIds = new Set(plans.map((plan) => plan.id));
    const jobs = state.jobs.filter((job) => planIds.has(job.planId)).sort(newestFirst);
    const latestJob = jobs[0] ?? null;
    const localModel = state.models
      .filter((model) => model.tasksetId === taskset.id && model.status === "imported")
      .sort((left, right) => right.importedAt.localeCompare(left.importedAt))[0] ?? null;
    const latestPlan = latestJob ? planById.get(latestJob.planId) ?? null : plans.sort(newestFirst)[0] ?? null;
    const method = tasksetMethod(taskset);
    return {
      taskset,
      name: modelName(taskset.name, method),
      method,
      latestPlan,
      latestJob,
      localModel,
      runCount: jobs.length,
      status: latestJob ? statusLabel(latestJob.status) : taskset.readiness?.ready ? "Ready" : "Needs review",
      updatedAt: latestJob?.updatedAt ?? taskset.updatedAt,
    };
  }).sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
}

export function jobsForTaskset(state: TrainingStateResponse | null, tasksetId: string): TrainingJob[] {
  if (!state) return [];
  const planIds = new Set(state.plans.filter((plan) => plan.tasksetId === tasksetId).map((plan) => plan.id));
  return state.jobs.filter((job) => planIds.has(job.planId)).sort(newestFirst);
}

export function planForJob(state: TrainingStateResponse | null, job: TrainingJob | null): TrainingPlan | null {
  return job && state ? state.plans.find((plan) => plan.id === job.planId) ?? null : null;
}

export function artifactsForJob(state: TrainingStateResponse | null, jobId: string | null): TrainingArtifact[] {
  return jobId && state ? state.artifacts.filter((artifact) => artifact.jobId === jobId) : [];
}

export function tasksetMethod(taskset: Taskset): string {
  const authoredMethod = taskset.metadata.trainingMethod;
  if (typeof authoredMethod === "string" && authoredMethod !== "none") return authoredMethod;
  if (taskset.readiness?.recommendedMethod && taskset.readiness.recommendedMethod !== "none") return taskset.readiness.recommendedMethod;
  return taskset.capabilities.compatibleMethods.find((method) => !["none", "retrieval"].includes(method)) ?? "sft";
}

export function modelName(value: string, _method: string): string {
  const name = /\b(model|adapter)\s*$/i.test(value.trim()) ? value.trim() : `${value.trim()} model`;
  return name;
}

export function statusLabel(status: string): string {
  return status.replaceAll("_", " ").replace(/^./, (value) => value.toUpperCase());
}

export function destinationLabel(destination: string): string {
  const labels: Record<string, string> = {
    export: "Export only",
    local_cpu_fixture: "Local CPU",
    local_cuda: "Local GPU",
    local_mlx: "Apple Silicon",
    ssh_gpu: "SSH GPU",
    runpod_byoc: "RunPod",
    prime_hosted: "Prime hosted",
    fireworks: "Fireworks",
    openpond_managed: "OpenPond managed",
  };
  return labels[destination] ?? destination.replaceAll("_", " ");
}

export function formatDateTime(value: string | null): string {
  if (!value) return "Not started";
  return new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" }).format(new Date(value));
}

export function formatDuration(startedAt: string | null, completedAt: string | null): string {
  if (!startedAt) return "Not started";
  const end = completedAt ? new Date(completedAt).getTime() : Date.now();
  const seconds = Math.max(0, Math.round((end - new Date(startedAt).getTime()) / 1_000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  return `${minutes}m ${seconds % 60}s`;
}

function newestFirst(left: { createdAt: string }, right: { createdAt: string }) {
  return right.createdAt.localeCompare(left.createdAt);
}
