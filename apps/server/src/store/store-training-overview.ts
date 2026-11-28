import type { TrainingNavigationResponse } from "@openpond/contracts";
import type { TrainingActivityState } from "../training/training-activity.js";
import { SqliteStoreDomain } from "./store-domain.js";

const ACTIVE_JOBS = "('queued','starting','running','cancelling','reconciling')";

/** Navigation and polling read metadata, never task bodies or evaluation traces. */
export class SqliteTrainingOverviewStore extends SqliteStoreDomain {
  async readTrainingActivityState(profileId: string): Promise<Omit<TrainingActivityState, "jobs">> {
    await this.ready;
    await this.writeQueue;
    const [creations, minerRuns, datasetImports, tasksetDrafts, tasksets, modelProjects, localModelRuns] =
      await Promise.all([
        this.all<TrainingActivityState["creations"][number]>(
          "SELECT id, state, updated_at AS updatedAt FROM task_creation_snapshots WHERE profile_id = ? AND COALESCE(json_extract(payload, '$.request.buildSpecification.kind'), '') != 'agent_benchmark'",
          [profileId],
        ),
        this.all<TrainingActivityState["minerRuns"][number]>(
          "SELECT id, status, updated_at AS updatedAt FROM task_miner_runs WHERE profile_id = ?",
          [profileId],
        ),
        this.all<TrainingActivityState["datasetImports"][number]>(
          "SELECT id, status, updated_at AS updatedAt FROM dataset_import_jobs WHERE profile_id = ?",
          [profileId],
        ),
        this.all<TrainingActivityState["tasksetDrafts"][number]>(
          "SELECT id, json_extract(payload, '$.revision') AS revision, updated_at AS updatedAt FROM taskset_drafts WHERE profile_id = ?",
          [profileId],
        ),
        this.all<TrainingActivityState["tasksets"][number]>(
          "SELECT id, json_extract(payload, '$.revision') AS revision, json_extract(payload, '$.contentHash') AS contentHash, updated_at AS updatedAt FROM tasksets WHERE profile_id = ?",
          [profileId],
        ),
        // Model projects form one account-wide library, matching the full state read.
        this.all<TrainingActivityState["modelProjects"][number]>(
          "SELECT id, json_extract(payload, '$.revision') AS revision, updated_at AS updatedAt FROM model_projects",
        ),
        this.all<NonNullable<TrainingActivityState["localModelRuns"]>[number]>(
          "SELECT id, status, updated_at AS updatedAt FROM model_runs WHERE json_extract(payload, '$.destinationId') = 'local_cuda'",
        ),
      ]);
    return { creations, minerRuns, datasetImports, tasksetDrafts, tasksets, modelProjects, localModelRuns };
  }

  async readTrainingNavigation(profileId: string): Promise<TrainingNavigationResponse> {
    await this.ready;
    await this.writeQueue;
    const [projects, runs, jobs, sources] = await Promise.all([
      this.all<TrainingNavigationResponse["projects"][number]>(
        `SELECT id, json_extract(payload, '$.name') AS name, profile_id AS profileId,
          json_extract(payload, '$.hosted.teamId') AS teamId, json_extract(payload, '$.hosted.projectId') AS hostedProjectId,
          json_extract(payload, '$.hosted.apiOrigin') AS apiOrigin FROM model_projects ORDER BY updated_at DESC, id`,
      ),
      this.all<{
        modelId: string;
        status: string;
        runKey: string;
        jobId: string | null;
        gpuType: string | null;
        gpuCount: number | null;
      }>(`SELECT r.model_id AS modelId, COALESCE(j.status, json_extract(r.payload, '$.localSft.phase'),
          CASE r.status WHEN 'prepared' THEN 'starting' ELSE 'running' END) AS status,
          'model-run:' || r.id AS runKey, j.id AS jobId,
          COALESCE(json_extract(j.payload, '$.metadata.managedTrainingEvidence.resource.gpuType'),
            json_extract(r.payload, '$.localSft.progress.gpuName')) AS gpuType,
          COALESCE(json_extract(j.payload, '$.metadata.managedTrainingEvidence.resource.gpuCount'),
            CASE WHEN json_extract(r.payload, '$.localSft.progress.gpuName') IS NOT NULL THEN 1 END) AS gpuCount
        FROM model_runs r LEFT JOIN training_jobs j ON j.id = (
          SELECT id FROM training_jobs WHERE json_extract(payload, '$.metadata.modelRunId') = r.id AND destination_id = 'openpond_managed' ORDER BY updated_at DESC, id DESC LIMIT 1
        ) WHERE r.status IN ('prepared','running') AND json_extract(r.payload, '$.kind') != 'evaluation'
          AND (j.id IS NULL OR j.status IN ${ACTIVE_JOBS}) ORDER BY r.updated_at DESC, r.id DESC`),
      this.all<{
        modelId: string | null;
        status: string;
        runKey: string;
        jobId: string;
        gpuType: string | null;
        gpuCount: number | null;
      }>(`SELECT json_extract(p.payload, '$.modelId') AS modelId, j.status, 'job:' || j.id AS runKey, j.id AS jobId,
          json_extract(j.payload, '$.metadata.managedTrainingEvidence.resource.gpuType') AS gpuType,
          json_extract(j.payload, '$.metadata.managedTrainingEvidence.resource.gpuCount') AS gpuCount
        FROM training_jobs j JOIN training_plans p ON p.id = j.plan_id
        WHERE j.status IN ${ACTIVE_JOBS} AND j.destination_id = 'openpond_managed' ORDER BY j.updated_at DESC, j.id DESC`),
      this.all<{ sessionId: string }>(
        `SELECT DISTINCT json_extract(s.payload, '$.sessionId') AS sessionId FROM training_sources s
        WHERE s.profile_id = ? AND json_extract(s.payload, '$.sessionId') IS NOT NULL AND EXISTS (
          SELECT 1 FROM task_creation_snapshots c, json_each(c.payload, '$.request.sourceIds') source
          WHERE c.profile_id = ? AND source.value = s.id
        )`,
        [profileId, profileId],
      ),
    ]);
    const activityByProjectId: TrainingNavigationResponse["activityByProjectId"] = {};
    const labels: Record<string, string> = {
      queued: "Queued",
      starting: "Starting",
      running: "Training",
      cancelling: "Cancelling",
      reconciling: "Reconciling",
    };
    const linkedJobs = new Set(runs.map(run => run.jobId));
    for (const item of [...runs, ...jobs.filter(job => !linkedJobs.has(job.jobId))]) {
      if (!item.modelId) continue;
      const current = activityByProjectId[item.modelId];
      if (current) {
        current.activeRuns++;
        continue;
      }
      activityByProjectId[item.modelId] = {
        status: item.status,
        label: labels[item.status] ?? "Active",
        runKey: item.runKey,
        activeRuns: 1,
        gpuCount: typeof item.gpuCount === "number" && Number.isSafeInteger(item.gpuCount) && item.gpuCount > 0 ? item.gpuCount : null,
        gpuType: typeof item.gpuType === "string" ? item.gpuType : null,
      };
    }
    return {
      projects,
      activityByProjectId,
      creationSessionIds: sources.map((source) => source.sessionId),
    };
  }
}
