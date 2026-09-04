import {
  ModelProjectSchema,
  PolicyOptimizationMetricSchema,
  TrainingJobEventSchema,
  TrainingJobSchema,
  type ModelProject,
  type Taskset,
  type TrainingJob,
  type TrainingJobEvent,
} from "@openpond/contracts";
import { TasksetReleaseSchema, type TasksetRelease } from "@openpond/evals";
import {
  createModelProjectsClient,
  OPENPOND_MODEL_PROJECT_MEDIA_TYPE,
  type HostedModelProjectDetail,
} from "openpond-sdk/model-projects";
import { z } from "zod";
import { gzipSync } from "node:zlib";

import type { SqliteStore } from "../store/store.js";
import { hostedApiAuthHeaders } from "../openpond/hosted-api-access.js";
import {
  listHostedModelProjectCatalog,
  type HostedModelProjectCatalogItem,
} from "./hosted-model-project-catalog.js";
import { hostedModelProjectTrainingSetup } from "./model-project-hosted-projection.js";
import {
  buildIntent,
  canReplaceFromHosted,
  errorMessage,
  isProjectSyncConflict,
  requireProject,
  upsertTasksetSync,
} from "./model-project-hosting-utils.js";

export type {
  HostedModelProjectCatalogItem,
  HostedModelProjectLocalState,
} from "./hosted-model-project-catalog.js";

type HostedAccess = {
  apiBaseUrl: string;
  token: string;
  teamId: string;
};

const HostedProjectSchema = z.object({
  id: z.string().min(1),
  portableProjectId: z.string().min(1),
  revision: z.number().int().positive(),
  etag: z.string().regex(/^[a-f0-9]{64}$/),
}).passthrough();

const HostedTasksetSchema = z.object({
  id: z.string().min(1),
  portableTasksetId: z.string().min(1).nullable(),
  revision: z.number().int().positive(),
  contentHash: z.string().regex(/^[a-f0-9]{64}$/),
}).passthrough();

const PORTABLE_TASKSET_PUBLICATION_CONTENT_TYPE =
  "application/vnd.openpond.taskset-publication+json+gzip";
const HostedManagedJobSchema = z.object({
  id: z.string().min(1),
  teamId: z.string().min(1),
  modelProjectId: z.string().min(1),
  portableProjectId: z.string().min(1),
  sourceProjectRevision: z.number().int().positive(),
  publicSubmissionHash: z.string().regex(/^[a-f0-9]{64}$/),
  approvalHash: z.string().regex(/^[a-f0-9]{64}$/),
  inputBundleSha256: z.string().regex(/^[a-f0-9]{64}$/),
  state: z.string().min(1),
  targetGroups: z.number().int().nonnegative(),
  completedGroups: z.number().int().nonnegative(),
  optimizerUpdatesApplied: z.number().int().nonnegative(),
  optimizerUpdatesSkipped: z.number().int().nonnegative(),
  currentPolicyVersion: z.number().int().nonnegative(),
  spendCapUsd: z.union([z.string(), z.number()]),
  accruedSpendUsd: z.union([z.string(), z.number()]),
  terminalReason: z.string().nullable(),
  canonicalPublishState: z.string().nullable(),
  canonicalAdapterArtifactId: z.string().nullable(),
  createdAt: z.string().datetime({ offset: true }),
  updatedAt: z.string().datetime({ offset: true }),
  completedAt: z.string().datetime({ offset: true }).nullable(),
  publicSubmission: z.object({
    job: z.object({
      recipe: z.object({ method: z.string().min(1) }).passthrough(),
      baseModel: z.object({ modelId: z.string().min(1) }).passthrough(),
      resumeFrom: z.object({ id: z.string().min(1) }).passthrough().nullable().optional(),
    }).passthrough(),
    source: z.object({
      taskset: z.object({
        id: z.string().min(1),
        revision: z.number().int().positive(),
        contentHash: z.string().regex(/^[a-f0-9]{64}$/),
      }).passthrough(),
    }).passthrough(),
  }).passthrough(),
}).passthrough();

const HostedManagedJobListSchema = z.object({
  jobs: z.array(z.unknown()),
});

const HostedTrainingStepSchema = z.object({
  id: z.string().min(1),
  jobId: z.string().min(1),
  stepIndex: z.number().int().nonnegative(),
  inputPolicyVersion: z.number().int().nonnegative(),
  outputPolicyVersion: z.number().int().nonnegative(),
  state: z.string().min(1),
  metrics: z.record(z.string(), z.unknown()),
  committedAt: z.string().datetime({ offset: true }).nullable().optional(),
  updatedAt: z.string().datetime({ offset: true }),
}).passthrough();

const HostedEvaluationSchema = z.object({
  id: z.string().min(1),
  jobId: z.string().min(1),
  policyVersion: z.number().int().nonnegative(),
  kind: z.string().min(1),
  state: z.string().min(1),
  score: z.union([z.string(), z.number()]).nullable(),
  threshold: z.union([z.string(), z.number()]).nullable(),
  passed: z.boolean().nullable(),
  metrics: z.record(z.string(), z.unknown()),
  completedAt: z.string().datetime({ offset: true }).nullable().optional(),
  updatedAt: z.string().datetime({ offset: true }),
}).passthrough();

const HostedCheckpointSchema = z.object({
  id: z.string().min(1),
  jobId: z.string().min(1),
  policyVersion: z.number().int().nonnegative(),
  state: z.string().min(1),
  createdAt: z.string().datetime({ offset: true }),
  updatedAt: z.string().datetime({ offset: true }),
}).passthrough();

const HostedArtifactSchema = z.object({
  id: z.string().min(1),
  jobId: z.string().min(1),
  state: z.string().min(1),
  artifactType: z.string().min(1),
  validationMetrics: z.record(z.string(), z.unknown()).nullable().optional(),
  readyAt: z.string().datetime({ offset: true }).nullable().optional(),
  updatedAt: z.string().datetime({ offset: true }),
}).passthrough();

const HostedManagedJobDetailSchema = z.object({
  job: z.object({
    job: HostedManagedJobSchema,
    trainingSteps: z.array(HostedTrainingStepSchema).default([]),
    evaluations: z.array(HostedEvaluationSchema).default([]),
    checkpoints: z.array(HostedCheckpointSchema).default([]),
    artifacts: z.array(HostedArtifactSchema).default([]),
  }).passthrough(),
});

type HostedManagedJob = z.infer<typeof HostedManagedJobSchema>;
type HostedManagedJobDetail = z.infer<typeof HostedManagedJobDetailSchema>["job"];

export function createModelProjectHostingService(input: {
  store: SqliteStore;
  resolveAccess: () => Promise<HostedAccess>;
  env?: NodeJS.ProcessEnv;
  fetch?: typeof fetch;
}) {
  const fetchImpl = input.fetch ?? fetch;

  async function listProjects(options: { refresh?: boolean } = {}): Promise<{
    teamId: string;
    projects: HostedModelProjectCatalogItem[];
    generatedAt: string;
    cached: boolean;
  }> {
    return listHostedModelProjectCatalog({
      store: input.store,
      resolveAccess: input.resolveAccess,
      fetch: fetchImpl,
    }, options);
  }

  async function pullProject(inputValue: {
    hostedProjectId: string;
    profileId: string;
  }): Promise<{
    project: ModelProject;
    hosted: HostedModelProjectDetail;
    importedJobCount: number;
    importedMetricCount: number;
  }> {
    const access = await input.resolveAccess();
    const [hosted, hostedJobs] = await Promise.all([
      hostedClient(access).get(inputValue.hostedProjectId),
      listHostedJobs(access, inputValue.hostedProjectId),
    ]);
    const summary = hosted.project;
    const existing = await input.store.getModelProject(summary.portableProjectId);
    if (existing && !canReplaceFromHosted(existing, summary, access.teamId)) {
      throw new Error(
        `Model Project ${summary.portableProjectId} has local changes or belongs to a different hosted workspace. Pulling would overwrite local work.`,
      );
    }
    if (
      existing?.hosted?.teamId === access.teamId &&
      existing.hosted.projectId === summary.id &&
      existing.hosted.etag === summary.etag &&
      existing.revision === summary.sourceRevision
    ) {
      const importedMetricCount = await importHostedJobs(
        existing,
        hostedJobs,
        access,
      );
      return {
        project: existing,
        hosted,
        importedJobCount: hostedJobs.length,
        importedMetricCount,
      };
    }

    const syncedAt = new Date().toISOString();
    const preserveHostedTasksets =
      existing?.hosted?.teamId === access.teamId &&
      existing.hosted.projectId === summary.id;
    const project = ModelProjectSchema.parse({
      schemaVersion: "openpond.modelProject.v2",
      id: summary.portableProjectId,
      profileId: existing?.profileId ?? inputValue.profileId,
      revision: summary.sourceRevision,
      name: summary.name,
      objective: summary.objective,
      defaultBaseModel: summary.defaultBaseModel,
      defaultDestinationId: summary.defaultDestinationId,
      trainingSetup: summary.trainingSetup,
      hosted: {
        schemaVersion: "openpond.hostedModelProjectLink.v1",
        teamId: access.teamId,
        projectId: summary.id,
        portableProjectId: summary.portableProjectId,
        revision: summary.revision,
        etag: summary.etag,
        syncedSourceRevision: summary.sourceRevision,
        syncedAt,
        tasksets: preserveHostedTasksets ? existing.hosted!.tasksets : [],
      },
      tasksetSyncs: preserveHostedTasksets ? existing.tasksetSyncs : [],
      createdAt: existing?.createdAt ?? summary.createdAt,
      updatedAt: summary.sourceUpdatedAt,
    });
    const saved = await input.store.saveModelProject(project);
    const importedMetricCount = await importHostedJobs(
      saved,
      hostedJobs,
      access,
    );
    return {
      project: saved,
      hosted,
      importedJobCount: hostedJobs.length,
      importedMetricCount,
    };
  }

  async function listHostedJobs(
    access: HostedAccess,
    hostedProjectId: string,
  ): Promise<HostedManagedJob[]> {
    const headers = hostedApiAuthHeaders(access.token);
    headers.set("accept", "application/json");
    headers.set("x-openpond-team-id", access.teamId);
    const url = new URL("/v1/managed-rl/jobs", access.apiBaseUrl);
    url.searchParams.set("modelProjectId", hostedProjectId);
    url.searchParams.set("limit", "100");
    const response = await fetchImpl(url, { headers });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) {
      throw new Error(`Hosted run history request failed (${response.status}).`);
    }
    return HostedManagedJobListSchema.parse(payload).jobs.flatMap((value) => {
      const parsed = HostedManagedJobSchema.safeParse(value);
      if (
        !parsed.success ||
        parsed.data.teamId !== access.teamId ||
        parsed.data.modelProjectId !== hostedProjectId
      ) {
        return [];
      }
      return [parsed.data];
    });
  }

  async function importHostedJobs(
    project: ModelProject,
    jobs: HostedManagedJob[],
    access: HostedAccess,
  ): Promise<number> {
    const existingJobs = await Promise.all(
      jobs.map((job) => input.store.getTrainingJob(job.id)),
    );
    const pendingDetails = jobs.flatMap((job, index) => {
      const existing = existingJobs[index];
      return existing?.metadata.hostedMetricsImportedForUpdatedAt === job.updatedAt
        ? []
        : [job];
    });
    const details = await mapWithConcurrency(
      pendingDetails,
      4,
      (job) => getHostedJobDetail(access, job),
    );
    const detailByJobId = new Map(
      details.map((detail) => [detail.job.id, detail] as const),
    );
    let importedMetricCount = 0;
    for (const [index, hostedJob] of jobs.entries()) {
      const detail = detailByJobId.get(hostedJob.id) ?? null;
      const existing = existingJobs[index] ?? null;
      const events = detail ? hostedTrainingJobEvents(detail) : [];
      importedMetricCount += events.filter(
        (event) => event.type === "metric",
      ).length;
      await input.store.saveTrainingJob(hostedTrainingJob(
        project,
        hostedJob,
        access,
        detail,
        existing,
      ));
      for (const event of events) {
        await input.store.saveTrainingJobEvent(event);
      }
    }
    return importedMetricCount;
  }

  async function getHostedJobDetail(
    access: HostedAccess,
    summary: HostedManagedJob,
  ): Promise<HostedManagedJobDetail> {
    const headers = hostedApiAuthHeaders(access.token);
    headers.set("accept", "application/json");
    headers.set("x-openpond-team-id", access.teamId);
    const url = new URL(
      `/v1/managed-rl/jobs/${encodeURIComponent(summary.id)}`,
      access.apiBaseUrl,
    );
    const response = await fetchImpl(url, { headers });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) {
      throw new Error(
        `Hosted run ${summary.id} detail request failed (${response.status}).`,
      );
    }
    const detail = HostedManagedJobDetailSchema.parse(payload).job;
    if (
      detail.job.id !== summary.id ||
      detail.job.teamId !== access.teamId ||
      detail.job.modelProjectId !== summary.modelProjectId
    ) {
      throw new Error(`Hosted run ${summary.id} detail did not match its summary.`);
    }
    return detail;
  }

  function hostedClient(access: HostedAccess) {
    const headers = hostedApiAuthHeaders(access.token);
    headers.set("x-openpond-team-id", access.teamId);
    return createModelProjectsClient({
      baseUrl: access.apiBaseUrl,
      fetch: fetchImpl,
      headers,
    });
  }

  async function syncProject(projectId: string): Promise<ModelProject> {
    const project = await requireProject(input.store, projectId);
    const access = await input.resolveAccess();
    const syncBody = {
      schemaVersion: "openpond.hostedModelProjectSync.v2" as const,
      portableProjectId: project.id,
      name: project.name,
      objective: project.objective,
      defaultBaseModel: project.defaultBaseModel,
      defaultDestinationId: project.defaultDestinationId,
      trainingSetup: hostedModelProjectTrainingSetup(project.trainingSetup),
      sourceRevision: project.revision,
      sourceUpdatedAt: project.updatedAt,
    };
    let hosted: { project: unknown };
    try {
      hosted = await requestJson<{ project: unknown }>({
        access,
        pathname: `/v1/model-projects/${encodeURIComponent(project.id)}`,
        method: "PUT",
        body: {
          ...syncBody,
          expectedEtag: project.hosted?.etag ?? null,
        },
      });
    } catch (caught) {
      if (!isProjectSyncConflict(caught)) throw caught;
      // Desktop is the authoring source for this container. A prior successful
      // release publication can leave its local container ETag behind; retry
      // the same source revision without the stale compare-and-swap token.
      hosted = await requestJson<{ project: unknown }>({
        access,
        pathname: `/v1/model-projects/${encodeURIComponent(project.id)}`,
        method: "PUT",
        body: { ...syncBody, expectedEtag: null },
      });
    }
    const hostedProject = HostedProjectSchema.parse(hosted.project);
    const syncedAt = new Date().toISOString();
    const saved = ModelProjectSchema.parse({
      ...project,
      hosted: {
        schemaVersion: "openpond.hostedModelProjectLink.v1",
        teamId: access.teamId,
        projectId: hostedProject.id,
        portableProjectId: hostedProject.portableProjectId,
        revision: hostedProject.revision,
        etag: hostedProject.etag,
        syncedSourceRevision: project.revision,
        syncedAt,
        tasksets: project.hosted?.teamId === access.teamId
          ? project.hosted.tasksets
          : [],
      },
    });
    await input.store.saveModelProject(saved);
    return saved;
  }

  async function publishTaskset(inputValue: {
    projectId: string;
    taskset: Taskset;
    release: TasksetRelease;
  }): Promise<ModelProject> {
    const release = TasksetReleaseSchema.parse(inputValue.release);
    const existingProject = await requireProject(input.store, inputValue.projectId);
    const access = await input.resolveAccess();
    const matchingRelease = existingProject.hosted?.teamId === access.teamId
      && existingProject.hosted.tasksets.some(
        (entry) =>
          entry.localTasksetId === inputValue.taskset.id
          && entry.releaseId === release.id
          && entry.releaseRevision === release.revision
          && entry.releaseHash === release.contentHash,
      );
    // A managed Run references an already published immutable release. Avoid
    // rewriting the project container on every launch: doing so turns a
    // harmless stale container ETag into a launch-blocking sync conflict.
    if (matchingRelease) return existingProject;
    await recordTasksetSync({
      projectId: inputValue.projectId,
      taskset: inputValue.taskset,
      release,
      state: "syncing",
      hostedTasksetId: null,
      error: null,
    });
    let project: ModelProject;
    try {
      project = await syncProject(inputValue.projectId);
    } catch (caught) {
      await recordTasksetSync({
        projectId: inputValue.projectId,
        taskset: inputValue.taskset,
        release,
        state: "sync_failed",
        hostedTasksetId: null,
        error: errorMessage(caught),
      });
      throw caught;
    }
    if (!project.hosted) throw new Error("Hosted Model Project link was not persisted.");
    if (project.hosted.teamId !== access.teamId) {
      throw new Error("Model Project is linked to a different hosted workspace.");
    }
    let response: { project: unknown; taskset: unknown };
    try {
      response = await requestJson<{ project: unknown; taskset: unknown }>({
        access,
        pathname: "/v1/taskset-releases",
        method: "POST",
        body: {
          schemaVersion: "openpond.portableTasksetPublication.v1",
          modelProjectId: project.hosted.projectId,
          name: inputValue.taskset.name,
          description: inputValue.taskset.objective,
          buildIntent: buildIntent(inputValue.taskset),
          methodHint: null,
          release,
        },
        gzip: true,
      });
    } catch (caught) {
      await recordTasksetSync({
        projectId: inputValue.projectId,
        taskset: inputValue.taskset,
        release,
        state: "sync_failed",
        hostedTasksetId: null,
        error: errorMessage(caught),
      });
      throw caught;
    }
    const hostedProject = HostedProjectSchema.parse(response.project);
    const hostedTaskset = HostedTasksetSchema.parse(response.taskset);
    const syncedAt = new Date().toISOString();
    const tasksets = [
      ...project.hosted.tasksets.filter(
        (entry) =>
          entry.localTasksetId !== inputValue.taskset.id ||
          entry.releaseHash !== release.contentHash,
      ),
      {
        localTasksetId: inputValue.taskset.id,
        releaseId: release.id,
        releaseRevision: release.revision,
        releaseHash: release.contentHash,
        hostedTasksetId: hostedTaskset.id,
        syncedAt,
      },
    ];
    const saved = ModelProjectSchema.parse({
      ...project,
      hosted: {
        ...project.hosted,
        projectId: hostedProject.id,
        revision: hostedProject.revision,
        etag: hostedProject.etag,
        syncedAt,
        tasksets,
      },
      tasksetSyncs: upsertTasksetSync(project.tasksetSyncs ?? [], {
        localTasksetId: inputValue.taskset.id,
        releaseId: release.id,
        releaseRevision: release.revision,
        releaseHash: release.contentHash,
        state: "synced",
        hostedTasksetId: hostedTaskset.id,
        lastAttemptAt: syncedAt,
        syncedAt,
        lastError: null,
      }),
    });
    await input.store.saveModelProject(saved);
    return saved;
  }

  async function requestJson<T>(request: {
    access: HostedAccess;
    pathname: string;
    method: "POST" | "PUT";
    body: unknown;
    gzip?: boolean;
  }): Promise<T> {
    const url = `${request.access.apiBaseUrl}${request.pathname}`;
    const headers = hostedApiAuthHeaders(request.access.token);
    const isModelProjectRequest = request.pathname.startsWith("/v1/model-projects/");
    headers.set(
      "accept",
      isModelProjectRequest ? OPENPOND_MODEL_PROJECT_MEDIA_TYPE : "application/json",
    );
    headers.set(
      "content-type",
      request.gzip
        ? PORTABLE_TASKSET_PUBLICATION_CONTENT_TYPE
        : isModelProjectRequest
          ? OPENPOND_MODEL_PROJECT_MEDIA_TYPE
          : "application/json",
    );
    headers.set("x-openpond-team-id", request.access.teamId);
    const response = await fetchImpl(url, {
      method: request.method,
      headers,
      body: request.gzip
        ? gzipSync(Buffer.from(JSON.stringify(request.body)))
        : JSON.stringify(request.body),
    });
    const payload = (await response.json().catch(() => ({}))) as Record<
      string,
      unknown
    >;
    if (!response.ok) {
      const endpoint = new URL(url);
      throw new Error(
        `${
          typeof payload.message === "string"
            ? typeof payload.code === "string"
              ? `${payload.message} (${payload.code})`
              : payload.message
            : typeof payload.error === "string"
              ? payload.error
              : typeof payload.code === "string"
                ? payload.code
            : "Hosted Model Project request failed"
        } (${response.status} ${endpoint.origin}${endpoint.pathname}).`,
      );
    }
    return payload as T;
  }

  return { listProjects, pullProject, publishTaskset, syncProject };

  async function recordTasksetSync(value: {
    projectId: string;
    taskset: Taskset;
    release: TasksetRelease;
    state: "syncing" | "sync_failed";
    hostedTasksetId: string | null;
    error: string | null;
  }): Promise<void> {
    const project = await requireProject(input.store, value.projectId);
    const timestamp = new Date().toISOString();
    await input.store.saveModelProject(ModelProjectSchema.parse({
      ...project,
      tasksetSyncs: upsertTasksetSync(project.tasksetSyncs ?? [], {
        localTasksetId: value.taskset.id,
        releaseId: value.release.id,
        releaseRevision: value.release.revision,
        releaseHash: value.release.contentHash,
        state: value.state,
        hostedTasksetId: value.hostedTasksetId,
        lastAttemptAt: timestamp,
        syncedAt: null,
        lastError: value.error,
      }),
    }));
  }
}

async function mapWithConcurrency<T, R>(
  values: T[],
  concurrency: number,
  map: (value: T) => Promise<R>,
): Promise<R[]> {
  const results: R[] = [];
  for (let offset = 0; offset < values.length; offset += concurrency) {
    results.push(...await Promise.all(
      values.slice(offset, offset + concurrency).map(map),
    ));
  }
  return results;
}

function hostedTrainingJobEvents(
  detail: HostedManagedJobDetail,
): TrainingJobEvent[] {
  const events: TrainingJobEvent[] = [];
  let sequence = 0;
  const append = (
    id: string,
    type: TrainingJobEvent["type"],
    timestamp: string,
    payload: Record<string, unknown>,
  ) => {
    events.push(TrainingJobEventSchema.parse({
      schemaVersion: "openpond.trainingJobEvent.v1",
      id: `hosted:${id}`,
      jobId: detail.job.id,
      sequence: sequence++,
      type,
      timestamp,
      payload,
    }));
  };

  const method = detail.job.publicSubmission.job.recipe.method;
  const representedMetrics = new Set([
    "learningRate",
    "loss",
    "policyLoss",
    "valueLoss",
    "gradientNorm",
    "rewardMean",
    "meanReward",
    "meanReturn",
    "approxKlPostUpdate",
    "sampledKl",
    "kl",
    "behaviorPolicyKlPreUpdate",
    "entropy",
    "clipFractionPostUpdate",
    "clipFraction",
    "policyClipFraction",
    "behaviorPolicyClipFractionPreUpdate",
    "valueClipFraction",
    "explainedVariance",
    "rolloutLearnerLag",
    "inputTokens",
    "outputTokens",
    "environmentExecutions",
    "trajectoryCount",
    "costUsd",
  ]);
  for (const step of [...detail.trainingSteps].sort(
    (left, right) => left.stepIndex - right.stepIndex,
  )) {
    const timestamp = step.committedAt ?? step.updatedAt;
    const metrics = step.metrics;
    if (method === "grpo" || method === "ppo") {
      const trajectoryCount = nonnegativeIntegerMetric(metrics, ["trajectoryCount"]);
      const policyMetric = PolicyOptimizationMetricSchema.parse({
        schemaVersion: "openpond.policyOptimizationMetric.v1",
        metricKind: "policy_optimization",
        method,
        step: step.outputPolicyVersion || step.stepIndex,
        timestamp,
        learningRate: nonnegativeMetric(metrics, ["learningRate"]),
        policyLoss: finiteMetric(metrics, ["policyLoss", "loss"]),
        valueLoss: finiteMetric(metrics, ["valueLoss"]),
        gradientNorm: nonnegativeMetric(metrics, ["gradientNorm"]),
        meanReward: finiteMetric(metrics, ["meanReward", "rewardMean"]),
        meanReturn: finiteMetric(metrics, ["meanReturn", "rewardMean"]),
        kl: finiteMetric(metrics, ["approxKlPostUpdate", "sampledKl", "kl"]),
        behaviorPolicyKlPreUpdate: nonnegativeMetric(
          metrics,
          ["behaviorPolicyKlPreUpdate"],
        ),
        entropy: finiteMetric(metrics, ["entropy"]),
        policyClipFraction: fractionMetric(
          metrics,
          ["policyClipFraction", "clipFractionPostUpdate", "clipFraction"],
        ),
        behaviorPolicyClipFractionPreUpdate: fractionMetric(
          metrics,
          ["behaviorPolicyClipFractionPreUpdate"],
        ),
        valueClipFraction: fractionMetric(metrics, ["valueClipFraction"]),
        explainedVariance: finiteMetric(metrics, ["explainedVariance"]),
        rolloutLearnerLag: nonnegativeIntegerMetric(metrics, ["rolloutLearnerLag"]),
        inputTokens: nonnegativeIntegerMetric(metrics, ["inputTokens"]) ?? 0,
        outputTokens: nonnegativeIntegerMetric(metrics, ["outputTokens"]) ?? 0,
        environmentExecutions:
          nonnegativeIntegerMetric(metrics, ["environmentExecutions"])
          ?? trajectoryCount
          ?? 0,
        trajectoryCount,
        costUsd: nonnegativeMetric(metrics, ["costUsd"]),
      });
      append(step.id, "metric", timestamp, {
        ...policyMetric,
        metricKind: "policy_optimization",
        hostedTrainingStepId: step.id,
        hostedTrainingStepState: step.state,
        inputPolicyVersion: step.inputPolicyVersion,
        outputPolicyVersion: step.outputPolicyVersion,
      });
    }
    for (const [name, value] of Object.entries(metrics)) {
      if (representedMetrics.has(name) || !isFiniteNumber(value)) continue;
      append(`${step.id}:metric:${name}`, "metric", timestamp, {
        metricKind: "managed_telemetry",
        metricId: `hosted.${toMetricId(name)}`,
        step: step.outputPolicyVersion || step.stepIndex,
        value,
        hostedTrainingStepId: step.id,
      });
    }
  }

  for (const evaluation of detail.evaluations) {
    const timestamp = evaluation.completedAt ?? evaluation.updatedAt;
    const score = numericValue(evaluation.score);
    if (score !== null) {
      append(`${evaluation.id}:score`, "metric", timestamp, {
        metricKind: "managed_telemetry",
        metricId: `evaluation.${toMetricId(evaluation.kind)}.score`,
        step: evaluation.policyVersion,
        value: score,
        evaluationId: evaluation.id,
        evaluationState: evaluation.state,
        threshold: numericValue(evaluation.threshold),
        passed: evaluation.passed,
      });
    }
    for (const [name, value] of Object.entries(evaluation.metrics)) {
      if (!isFiniteNumber(value)) continue;
      append(`${evaluation.id}:metric:${name}`, "metric", timestamp, {
        metricKind: "managed_telemetry",
        metricId: `evaluation.${toMetricId(evaluation.kind)}.${toMetricId(name)}`,
        step: evaluation.policyVersion,
        value,
        evaluationId: evaluation.id,
      });
    }
  }

  for (const artifact of detail.artifacts) {
    const timestamp = artifact.readyAt ?? artifact.updatedAt;
    for (const [name, value] of Object.entries(artifact.validationMetrics ?? {})) {
      if (!isFiniteNumber(value)) continue;
      append(`${artifact.id}:validation:${name}`, "metric", timestamp, {
        metricKind: "managed_telemetry",
        metricId: `validation.${toMetricId(name)}`,
        step: detail.job.currentPolicyVersion,
        value,
        artifactId: artifact.id,
        artifactType: artifact.artifactType,
      });
    }
  }

  for (const checkpoint of detail.checkpoints) {
    append(checkpoint.id, "checkpoint", checkpoint.updatedAt, {
      source: "hosted_model_project_import",
      checkpointId: checkpoint.id,
      policyVersion: checkpoint.policyVersion,
      state: checkpoint.state,
      createdAt: checkpoint.createdAt,
    });
  }
  return events;
}

function hostedTrainingJob(
  project: ModelProject,
  hosted: HostedManagedJob,
  access: HostedAccess,
  detail: HostedManagedJobDetail | null,
  existing: TrainingJob | null,
): TrainingJob {
  const submission = hosted.publicSubmission;
  const taskset = submission.source.taskset;
  const method = submission.job.recipe.method;
  const status = hostedTrainingJobStatus(hosted.state);
  const spendCapUsd = Number(hosted.spendCapUsd);
  const accruedSpendUsd = Number(hosted.accruedSpendUsd);
  return TrainingJobSchema.parse({
    schemaVersion: "openpond.trainingJob.v1",
    id: hosted.id,
    planId: `hosted:${project.id}:r${hosted.sourceProjectRevision}`,
    bundleHash: hosted.inputBundleSha256,
    approvalId: hosted.approvalHash,
    destinationId: "openpond_managed",
    status,
    nonProduction: false,
    workerPid: null,
    startedAt: hosted.createdAt,
    completedAt: hosted.completedAt,
    error:
      status === "failed"
        ? hosted.terminalReason?.trim() || "Hosted training run failed."
        : null,
    createdAt: hosted.createdAt,
    updatedAt: hosted.updatedAt,
    metadata: {
      ...existing?.metadata,
      source: "hosted_model_project_import",
      modelProjectId: project.id,
      hostedModelProjectId: hosted.modelProjectId,
      hostedTeamId: access.teamId,
      hostedJobId: hosted.id,
      hostedState: hosted.state,
      sourceProjectRevision: hosted.sourceProjectRevision,
      trainingMethod: method,
      baseModelId: submission.job.baseModel.modelId,
      tasksetId: taskset.id,
      tasksetRevision: taskset.revision,
      tasksetContentHash: taskset.contentHash,
      targetGroups: hosted.targetGroups,
      completedGroups: hosted.completedGroups,
      rolloutProgress: {
        groupsCompleted: hosted.completedGroups,
        groupsTarget: hosted.targetGroups,
        optimizerUpdatesApplied: hosted.optimizerUpdatesApplied,
        optimizerUpdatesSkipped: hosted.optimizerUpdatesSkipped,
      },
      currentPolicyVersion: hosted.currentPolicyVersion,
      spendCapUsd: Number.isFinite(spendCapUsd) ? spendCapUsd : null,
      accruedSpendUsd: Number.isFinite(accruedSpendUsd)
        ? accruedSpendUsd
        : null,
      canonicalPublishState: hosted.canonicalPublishState,
      canonicalAdapterArtifactId: hosted.canonicalAdapterArtifactId,
      parentHostedArtifactId: submission.job.resumeFrom?.id ?? null,
      importedAt: new Date().toISOString(),
      ...(detail ? {
        hostedMetricsImportedForUpdatedAt: hosted.updatedAt,
        hostedMetricsImportedAt: new Date().toISOString(),
        hostedTrainingStepCount: detail.trainingSteps.length,
        hostedEvaluationCount: detail.evaluations.length,
        hostedCheckpointCount: detail.checkpoints.length,
        hostedArtifactCount: detail.artifacts.length,
        hostedEvaluations: detail.evaluations.map((evaluation) => ({
          id: evaluation.id,
          kind: evaluation.kind,
          state: evaluation.state,
          policyVersion: evaluation.policyVersion,
          score: numericValue(evaluation.score),
          threshold: numericValue(evaluation.threshold),
          passed: evaluation.passed,
          metrics: evaluation.metrics,
          completedAt: evaluation.completedAt ?? null,
        })),
      } : {}),
    },
  });
}

function finiteMetric(
  metrics: Record<string, unknown>,
  names: string[],
): number | null {
  for (const name of names) {
    const value = metrics[name];
    if (isFiniteNumber(value)) return value;
  }
  return null;
}

function nonnegativeMetric(
  metrics: Record<string, unknown>,
  names: string[],
): number | null {
  const value = finiteMetric(metrics, names);
  return value !== null && value >= 0 ? value : null;
}

function nonnegativeIntegerMetric(
  metrics: Record<string, unknown>,
  names: string[],
): number | null {
  const value = finiteMetric(metrics, names);
  return value !== null && Number.isInteger(value) && value >= 0 ? value : null;
}

function fractionMetric(
  metrics: Record<string, unknown>,
  names: string[],
): number | null {
  const value = finiteMetric(metrics, names);
  return value !== null && value >= 0 && value <= 1 ? value : null;
}

function numericValue(value: string | number | null): number | null {
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value !== "string" || !value.trim()) return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function toMetricId(value: string): string {
  return value
    .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
    .replace(/[^a-zA-Z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .toLowerCase();
}

function hostedTrainingJobStatus(state: string): TrainingJob["status"] {
  if (state === "completed" || state === "succeeded") return "succeeded";
  if (state === "cancelled") return "cancelled";
  if (state === "failed") return "failed";
  if (state === "cancelling") return "cancelling";
  if (state === "reconciling") return "reconciling";
  if (state === "queued" || state === "pending") return "queued";
  if (state === "starting" || state === "provisioning") return "starting";
  return "running";
}
