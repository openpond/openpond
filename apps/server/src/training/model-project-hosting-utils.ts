import type { HostedModelProjectSummary } from "openpond-sdk/model-projects";

import type { ModelProject, Taskset } from "@openpond/contracts";
import type { SqliteStore } from "../store/store.js";

export function canReplaceFromHosted(
  local: ModelProject,
  hosted: HostedModelProjectSummary,
  teamId: string,
): boolean {
  return (
    local.hosted?.teamId === teamId
    && local.hosted.projectId === hosted.id
    && local.hosted.portableProjectId === hosted.portableProjectId
    && local.revision === local.hosted.syncedSourceRevision
  );
}

export function upsertTasksetSync(
  entries: ModelProject["tasksetSyncs"],
  entry: ModelProject["tasksetSyncs"][number],
): ModelProject["tasksetSyncs"] {
  return [
    ...entries.filter((candidate) => candidate.localTasksetId !== entry.localTasksetId),
    entry,
  ];
}

export function errorMessage(value: unknown): string {
  return value instanceof Error ? value.message : String(value);
}

export function isProjectSyncConflict(value: unknown): boolean {
  return errorMessage(value).startsWith("model_project_sync_conflict (");
}

export async function requireProject(
  store: SqliteStore,
  projectId: string,
): Promise<ModelProject> {
  const project = await store.getModelProject(projectId);
  if (!project) throw new Error("Model Project was not found.");
  return project;
}

export function buildIntent(
  taskset: Taskset,
): "demonstrations" | "preferences" | "verifiable_reward" | "rubric" | "discovery" {
  if (taskset.preferenceComparison) return "preferences";
  if (taskset.graders.some((grader) => grader.kind === "human")) return "preferences";
  if (taskset.graders.some((grader) => grader.rewardEligible)) return "verifiable_reward";
  return "discovery";
}
