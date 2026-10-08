import { TrainingActivityAuthoritySchema } from "../training/training-activity-authority.js";
import type {
  ModelArtifactLineage,
  ModelProject,
  TrainingApproval,
  TrainingArtifact,
  TrainingBundleManifest,
  TrainingJob,
  TrainingJobEvent,
  TrainingPlan,
} from "@openpond/contracts";
import {
  ModelArtifactLineageSchema,
  ModelProjectSchema,
  TrainingApprovalSchema,
  TrainingArtifactSchema,
  TrainingBundleManifestSchema,
  TrainingJobSchema,
  TrainingJobEventSchema,
  TrainingPlanSchema,
  ManagedAdapterServingProjectionSchema,
} from "@openpond/contracts";
import { SqliteStoreDomain } from "./store-domain.js";
const ACTIVE_TRAINING_DESTINATIONS_SQL = "('openpond_managed')";
export class SqliteTrainingJobsStore extends SqliteStoreDomain {
  async saveModelProject(projectInput: ModelProject): Promise<ModelProject> {
    const project = ModelProjectSchema.parse(projectInput);
    await this.upsertPayload(
      `INSERT INTO model_projects (id, profile_id, payload, created_at, updated_at) VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET profile_id = excluded.profile_id, payload = excluded.payload, updated_at = excluded.updated_at`,
      [
        project.id,
        project.profileId,
        JSON.stringify(project),
        project.createdAt,
        project.updatedAt,
      ],
    );
    return project;
  }

  async getModelProject(id: string): Promise<ModelProject | null> {
    return this.getParsedPayload(
      "SELECT payload FROM model_projects WHERE id = ?",
      [id],
      parseStoredModelProject,
    );
  }

  async listModelProjects(profileId?: string): Promise<ModelProject[]> {
    return this.listParsedPayloads(
      profileId
        ? "SELECT payload FROM model_projects WHERE profile_id = ? ORDER BY updated_at DESC"
        : "SELECT payload FROM model_projects ORDER BY updated_at DESC",
      profileId ? [profileId] : [],
      parseStoredModelProject,
    );
  }

  async saveTrainingPlan(planInput: TrainingPlan): Promise<TrainingPlan> {
    const plan = TrainingPlanSchema.parse(planInput);
    const existing = await this.getTrainingPlan(plan.id);
    if (existing && existing.contentHash !== plan.contentHash) {
      throw new Error(`Training Plan ${plan.id} is immutable and already has different content.`);
    }
    await this.upsertPayload(
      `INSERT INTO training_plans (id, taskset_id, destination_id, payload, created_at) VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET taskset_id = excluded.taskset_id, destination_id = excluded.destination_id, payload = excluded.payload`,
      [plan.id, plan.tasksetId, plan.destinationId, JSON.stringify(plan), plan.createdAt],
    );
    return plan;
  }

  async listTrainingPlans(tasksetId?: string): Promise<TrainingPlan[]> {
    return this.listParsedPayloads(
      tasksetId
        ? `SELECT payload FROM training_plans WHERE taskset_id = ? AND destination_id IN ${ACTIVE_TRAINING_DESTINATIONS_SQL} ORDER BY created_at DESC`
        : `SELECT payload FROM training_plans WHERE destination_id IN ${ACTIVE_TRAINING_DESTINATIONS_SQL} ORDER BY created_at DESC`,
      tasksetId ? [tasksetId] : [],
      TrainingPlanSchema.parse,
    );
  }

  async getTrainingPlan(id: string): Promise<TrainingPlan | null> {
    return this.getParsedPayload(
      `SELECT payload FROM training_plans WHERE id = ? AND destination_id IN ${ACTIVE_TRAINING_DESTINATIONS_SQL}`,
      [id],
      TrainingPlanSchema.parse,
    );
  }

  async saveTrainingBundle(bundleInput: TrainingBundleManifest): Promise<TrainingBundleManifest> {
    const bundle = TrainingBundleManifestSchema.parse(bundleInput);
    await this.upsertPayload(
      `INSERT INTO training_bundles (id, plan_id, content_hash, payload, created_at) VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET plan_id = excluded.plan_id, content_hash = excluded.content_hash, payload = excluded.payload`,
      [bundle.id, bundle.planId, bundle.contentHash, JSON.stringify(bundle), bundle.createdAt],
    );
    return bundle;
  }

  async getTrainingBundle(id: string): Promise<TrainingBundleManifest | null> {
    return this.getParsedPayload(
      "SELECT payload FROM training_bundles WHERE id = ?",
      [id],
      TrainingBundleManifestSchema.parse,
    );
  }

  async listTrainingBundles(planId?: string): Promise<TrainingBundleManifest[]> {
    return this.listParsedPayloads(
      planId
        ? "SELECT payload FROM training_bundles WHERE plan_id = ? ORDER BY created_at DESC"
        : "SELECT payload FROM training_bundles ORDER BY created_at DESC",
      planId ? [planId] : [],
      TrainingBundleManifestSchema.parse,
    );
  }

  async findTrainingBundleByPlanAndHash(
    planId: string,
    contentHash: string,
  ): Promise<TrainingBundleManifest | null> {
    return this.getParsedPayload(
      "SELECT payload FROM training_bundles WHERE plan_id = ? AND content_hash = ?",
      [planId, contentHash],
      TrainingBundleManifestSchema.parse,
    );
  }

  async saveTrainingJob(jobInput: TrainingJob): Promise<TrainingJob> {
    let job = TrainingJobSchema.parse(jobInput);
    const existing = await this.getTrainingJob(job.id);
    const previous = existing?.metadata.activityAuthority,
      requested = job.metadata.activityAuthority;
    if (previous !== undefined) {
      const authority = TrainingActivityAuthoritySchema.parse(previous);
      if (
        requested !== undefined &&
        JSON.stringify(TrainingActivityAuthoritySchema.parse(requested)) !==
          JSON.stringify(authority)
      )
        throw new Error("Training activity ownership cannot change during reconciliation.");
      job = { ...job, metadata: { ...job.metadata, activityAuthority: authority } };
    } else if (requested !== undefined) {
      if (existing)
        throw new Error("Historical training activity cannot be assigned a guessed owner.");
      job = {
        ...job,
        metadata: {
          ...job.metadata,
          activityAuthority: TrainingActivityAuthoritySchema.parse(requested),
        },
      };
    }
    await this.upsertPayload(
      `INSERT INTO training_jobs (id, plan_id, destination_id, status, payload, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET plan_id = excluded.plan_id, destination_id = excluded.destination_id, status = excluded.status,
       payload = CASE WHEN json_extract(training_jobs.payload,'$.metadata.activityAuthority') IS NOT NULL THEN json_set(excluded.payload,'$.metadata.activityAuthority',json_extract(training_jobs.payload,'$.metadata.activityAuthority')) ELSE excluded.payload END,
       updated_at = excluded.updated_at
       WHERE json_extract(excluded.payload,'$.metadata.activityAuthority') IS NULL OR json_extract(training_jobs.payload,'$.metadata.activityAuthority') = json_extract(excluded.payload,'$.metadata.activityAuthority')`,
      [
        job.id,
        job.planId,
        job.destinationId,
        job.status,
        JSON.stringify(job),
        job.createdAt,
        job.updatedAt,
      ],
    );
    const retained = await this.getTrainingJob(job.id);
    if (!retained) throw new Error("Training job was not retained.");
    if (
      job.metadata.activityAuthority !== undefined &&
      JSON.stringify(retained.metadata.activityAuthority) !==
        JSON.stringify(job.metadata.activityAuthority)
    )
      throw new Error("Training activity ownership changed during admission.");
    return retained;
  }

  async saveTrainingApproval(approvalInput: TrainingApproval): Promise<TrainingApproval> {
    const approval = TrainingApprovalSchema.parse(approvalInput);
    await this.upsertPayload(
      `INSERT INTO training_approvals (id, plan_id, bundle_hash, payload, created_at) VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET plan_id = excluded.plan_id, bundle_hash = excluded.bundle_hash, payload = excluded.payload`,
      [
        approval.id,
        approval.planId,
        approval.bundleHash,
        JSON.stringify(approval),
        approval.approvedAt,
      ],
    );
    return approval;
  }

  async getTrainingApproval(id: string): Promise<TrainingApproval | null> {
    return this.getParsedPayload(
      "SELECT payload FROM training_approvals WHERE id = ?",
      [id],
      TrainingApprovalSchema.parse,
    );
  }

  async getTrainingJob(id: string): Promise<TrainingJob | null> {
    return this.getParsedPayload(
      `SELECT payload FROM training_jobs WHERE id = ? AND destination_id IN ${ACTIVE_TRAINING_DESTINATIONS_SQL}`,
      [id],
      TrainingJobSchema.parse,
    );
  }

  async readTrainingExecutionActivity(input: {
    teamId: string;
    actorId: string;
    projectId: string | null;
    limit?: number;
  }) {
    const rows = await this.all<{ id: string; payload: string; total: number }>(
      `SELECT id,payload,count(*) OVER () AS total FROM training_jobs
      WHERE json_extract(payload,'$.metadata.activityAuthority.schemaVersion')='openpond.trainingActivityAuthority.v1'
      AND json_extract(payload,'$.metadata.activityAuthority.teamId')=? AND json_extract(payload,'$.metadata.activityAuthority.actorId')=?
      AND status IN ('queued','starting','running','cancelling','reconciling')
      AND destination_id != 'openpond_managed'
      ${input.projectId ? "AND json_extract(payload,'$.metadata.activityAuthority.projectId')=?" : ""}
      ORDER BY updated_at DESC,id DESC LIMIT ?`,
      [
        input.teamId,
        input.actorId,
        ...(input.projectId ? [input.projectId] : []),
        Math.min(100, Math.max(1, input.limit ?? 100)),
      ],
    );
    return {
      count: Number(rows[0]?.total ?? 0),
      items: rows.map((row) => {
        const job = TrainingJobSchema.parse(JSON.parse(row.payload));
        const modelId =
          typeof job.metadata.modelProjectId === "string" ? job.metadata.modelProjectId : null;
        if (!modelId)
          throw new Error("This qualified local training job has no retained model route.");
        return {
          kind: "training" as const,
          location: "local" as const,
          id: job.id,
          name: job.id,
          phase: typeof job.metadata.phase === "string" ? job.metadata.phase : job.status,
          updatedAt: job.updatedAt,
          href: `/models/${encodeURIComponent(modelId!)}/runs/${encodeURIComponent(`job:${job.id}`)}`,
        };
      }),
    };
  }

  async listTrainingJobs(): Promise<TrainingJob[]> {
    return this.listParsedPayloads(
      `SELECT payload FROM training_jobs WHERE destination_id IN ${ACTIVE_TRAINING_DESTINATIONS_SQL} ORDER BY updated_at DESC`,
      [],
      TrainingJobSchema.parse,
    );
  }

  async saveTrainingJobEvent(eventInput: TrainingJobEvent): Promise<TrainingJobEvent> {
    const event = TrainingJobEventSchema.parse(eventInput);
    await this.upsertPayload(
      `INSERT INTO training_job_events (id, job_id, sequence, payload, created_at) VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET job_id = excluded.job_id, sequence = excluded.sequence, payload = excluded.payload`,
      [event.id, event.jobId, event.sequence, JSON.stringify(event), event.timestamp],
    );
    return event;
  }

  async listTrainingJobEvents(jobId: string): Promise<TrainingJobEvent[]> {
    return this.listParsedPayloads(
      "SELECT payload FROM training_job_events WHERE job_id = ? ORDER BY sequence ASC",
      [jobId],
      TrainingJobEventSchema.parse,
    );
  }

  async saveTrainingArtifact(artifactInput: TrainingArtifact): Promise<TrainingArtifact> {
    const artifact = TrainingArtifactSchema.parse(artifactInput);
    await this.upsertPayload(
      `INSERT INTO training_artifacts (id, job_id, kind, payload, created_at) VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET job_id = excluded.job_id, kind = excluded.kind, payload = excluded.payload`,
      [artifact.id, artifact.jobId, artifact.kind, JSON.stringify(artifact), artifact.createdAt],
    );
    return artifact;
  }

  async listTrainingArtifacts(jobId?: string): Promise<TrainingArtifact[]> {
    return this.listParsedPayloads(
      jobId
        ? "SELECT payload FROM training_artifacts WHERE job_id = ? ORDER BY created_at DESC"
        : "SELECT payload FROM training_artifacts ORDER BY created_at DESC",
      jobId ? [jobId] : [],
      TrainingArtifactSchema.parse,
    );
  }

  async getTrainingArtifact(id: string): Promise<TrainingArtifact | null> {
    return this.getParsedPayload(
      "SELECT payload FROM training_artifacts WHERE id = ?",
      [id],
      TrainingArtifactSchema.parse,
    );
  }

  async saveModelArtifactLineage(
    lineageInput: ModelArtifactLineage,
  ): Promise<ModelArtifactLineage> {
    const lineage = ModelArtifactLineageSchema.parse(lineageInput);
    await this.upsertPayload(
      `INSERT INTO model_artifact_lineage (id, artifact_id, taskset_id, payload, created_at) VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET artifact_id = excluded.artifact_id, taskset_id = excluded.taskset_id, payload = excluded.payload`,
      [
        lineage.id,
        lineage.artifactId,
        lineage.tasksetId,
        JSON.stringify(lineage),
        lineage.importedAt,
      ],
    );
    return lineage;
  }

  async updateModelArtifactLineageServing(
    id: string,
    projection: ModelArtifactLineage["managedServing"],
  ): Promise<void> {
    const parsed =
      projection === null ? null : ManagedAdapterServingProjectionSchema.parse(projection);
    await this.upsertPayload(
      "UPDATE model_artifact_lineage SET payload = json_set(payload, '$.managedServing', json(?)) WHERE id = ?",
      [JSON.stringify(parsed), id],
    );
  }

  async updateModelArtifactLineageReview(
    id: string,
    patch: Pick<
      ModelArtifactLineage,
      "status" | "rejectedAt" | "rejectionReason" | "frozenEvaluationArtifactId"
    >,
  ): Promise<void> {
    const parsed = ModelArtifactLineageSchema.pick({
      status: true,
      rejectedAt: true,
      rejectionReason: true,
      frozenEvaluationArtifactId: true,
    }).parse(patch);
    await this.upsertPayload(
      "UPDATE model_artifact_lineage SET payload = json_set(payload, '$.status', ?, '$.rejectedAt', ?, '$.rejectionReason', ?, '$.frozenEvaluationArtifactId', ?) WHERE id = ?",
      [
        parsed.status,
        parsed.rejectedAt,
        parsed.rejectionReason,
        parsed.frozenEvaluationArtifactId,
        id,
      ],
    );
  }

  async listModelArtifactLineage(tasksetId?: string): Promise<ModelArtifactLineage[]> {
    return this.listParsedPayloads(
      tasksetId
        ? "SELECT payload FROM model_artifact_lineage WHERE taskset_id = ? ORDER BY created_at DESC"
        : "SELECT payload FROM model_artifact_lineage ORDER BY created_at DESC",
      tasksetId ? [tasksetId] : [],
      parseStoredModelArtifactLineage,
    );
  }

  async getModelArtifactLineage(id: string): Promise<ModelArtifactLineage | null> {
    return this.getParsedPayload(
      "SELECT payload FROM model_artifact_lineage WHERE id = ?",
      [id],
      parseStoredModelArtifactLineage,
    );
  }
}
function parseStoredModelProject(value: unknown): ModelProject {
  return ModelProjectSchema.parse(normalizeStoredModelProjectDestination(value));
}

function normalizeStoredModelProjectDestination(value: unknown): unknown {
  if (
    !isRecord(value) ||
    typeof value.defaultDestinationId !== "string" ||
    value.defaultDestinationId === "openpond_managed"
  ) {
    return value;
  }
  return { ...value, defaultDestinationId: null };
}

function parseStoredModelArtifactLineage(value: unknown): ModelArtifactLineage {
  return ModelArtifactLineageSchema.parse(normalizeStoredManagedServingProjection(value));
}

function normalizeStoredManagedServingProjection(value: unknown): unknown {
  if (!isRecord(value) || !isRecord(value.managedServing)) return value;
  const source = value.managedServing.source;
  if (source !== "openpond_fireworks" && source !== "openpond_training") return value;
  return { ...value, managedServing: null };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
