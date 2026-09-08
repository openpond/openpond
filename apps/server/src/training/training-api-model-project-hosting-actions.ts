import type { createModelProjectHostingService } from "./model-project-hosting.js";

type ModelProjectHosting = ReturnType<typeof createModelProjectHostingService>;
type HostingAction = "hosted_model_projects" | "pull_hosted_model_project" | "sync_model_project" | "hosted_taskset_runs" | "hosted_taskset_run" | "cancel_hosted_taskset_run" | "hosted_taskset_run_result";

const hostingActions = new Set<string>([
  "hosted_model_projects", "pull_hosted_model_project", "sync_model_project",
  "hosted_taskset_runs", "hosted_taskset_run", "cancel_hosted_taskset_run", "hosted_taskset_run_result",
]);

export function isModelProjectHostingAction(action: string): action is HostingAction {
  return hostingActions.has(action);
}

export async function runModelProjectHostingAction(
  service: ModelProjectHosting | undefined,
  action: HostingAction,
  input: Record<string, unknown>,
): Promise<unknown> {
  if (!service) throw new Error(`Hosted Model Project ${actionLabel(action)} is unavailable.`);
  if (["hosted_taskset_runs", "hosted_taskset_run", "cancel_hosted_taskset_run", "hosted_taskset_run_result"].includes(action)) {
    const scope = { modelId: requiredString(input.modelId, "modelId"), profileId: requiredString(input.profileId, "profileId") };
    if (action === "hosted_taskset_runs") return service.tasksetRuns.list({ ...scope, afterId: typeof input.afterId === "string" ? input.afterId : undefined, limit: 25 });
    const selected = { ...scope, runId: requiredString(input.runId, "runId") };
    if (action === "cancel_hosted_taskset_run") return service.tasksetRuns.cancel(selected);
    if (action === "hosted_taskset_run_result") return service.tasksetRuns.result(selected);
    return service.tasksetRuns.get(selected);
  }
  if (action === "hosted_model_projects") {
    return service.listProjects({ refresh: input.refresh === true });
  }
  if (action === "pull_hosted_model_project") {
    return service.pullProject({
      hostedProjectId: requiredString(input.hostedProjectId, "hostedProjectId"),
      profileId: requiredString(input.profileId, "profileId"),
    });
  }
  return service.syncProject(requiredString(input.modelId, "modelId"));
}

function actionLabel(action: HostingAction): string {
  if (action === "hosted_model_projects") return "discovery";
  if (action === "pull_hosted_model_project") return "pull";
  return "sync";
}

function requiredString(value: unknown, name: string): string {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${name} is required.`);
  return value.trim();
}
