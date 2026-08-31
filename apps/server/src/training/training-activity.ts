import type {
  TrainingActivityResponse,
  TrainingStateResponse,
} from "@openpond/contracts";
import { contentHash } from "@openpond/taskset-sdk";

type ActivityState = Pick<
  TrainingStateResponse,
  | "jobs"
  | "creations"
  | "minerRuns"
  | "datasetImports"
  | "tasksetDrafts"
  | "tasksets"
  | "modelProjects"
>;

const ACTIVE_JOB_STATUSES = new Set([
  "queued",
  "starting",
  "running",
  "cancelling",
  "reconciling",
]);
const ACTIVE_CREATION_STATES = new Set(["planning", "materializing", "validating"]);
const ACTIVE_MINER_STATUSES = new Set(["queued", "running", "cancelling"]);
const ACTIVE_IMPORT_STATUSES = new Set([
  "inspecting",
  "materializing",
  "validating",
  "cancelling",
]);

export function projectTrainingActivity(input: {
  profileId: string;
  state: ActivityState;
  generatedAt?: string;
}): TrainingActivityResponse {
  const activeCounts = {
    jobs: input.state.jobs.filter((item) => ACTIVE_JOB_STATUSES.has(item.status)).length,
    creations: input.state.creations.filter((item) =>
      ACTIVE_CREATION_STATES.has(item.state),
    ).length,
    minerRuns: input.state.minerRuns.filter((item) =>
      ACTIVE_MINER_STATUSES.has(item.status),
    ).length,
    datasetImports: input.state.datasetImports.filter((item) =>
      ACTIVE_IMPORT_STATUSES.has(item.status),
    ).length,
  };
  const revision = contentHash({
    jobs: revisions(input.state.jobs, (item) => [item.id, item.status, item.updatedAt]),
    creations: revisions(input.state.creations, (item) => [item.id, item.state, item.updatedAt]),
    minerRuns: revisions(input.state.minerRuns, (item) => [item.id, item.status, item.updatedAt]),
    datasetImports: revisions(input.state.datasetImports, (item) => [
      item.id,
      item.status,
      item.updatedAt,
    ]),
    tasksetDrafts: revisions(input.state.tasksetDrafts, (item) => [
      item.id,
      String(item.revision),
      item.updatedAt,
    ]),
    tasksets: revisions(input.state.tasksets, (item) => [
      item.id,
      String(item.revision),
      item.contentHash,
      item.updatedAt,
    ]),
    modelProjects: revisions(input.state.modelProjects, (item) => [
      item.id,
      String(item.revision),
      item.updatedAt,
    ]),
  });
  return {
    schemaVersion: "openpond.trainingActivity.v1",
    profileId: input.profileId,
    active: Object.values(activeCounts).some((count) => count > 0),
    activeCounts,
    revision,
    generatedAt: input.generatedAt ?? new Date().toISOString(),
  };
}

function revisions<T>(items: T[], project: (item: T) => string[]): string[][] {
  return items.map(project).sort((left, right) => left[0]!.localeCompare(right[0]!));
}
