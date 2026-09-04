import type { createModelProjectHostingService } from "./model-project-hosting.js";

type ModelProjectHosting = ReturnType<typeof createModelProjectHostingService>;
type HostingAction = "hosted_model_projects" | "pull_hosted_model_project" | "sync_model_project";

export async function runModelProjectHostingAction(
  service: ModelProjectHosting | undefined,
  action: HostingAction,
  input: Record<string, unknown>,
): Promise<unknown> {
  if (!service) throw new Error(`Hosted Model Project ${actionLabel(action)} is unavailable.`);
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
