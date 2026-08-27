import {
  ModelProjectSchema,
  type ModelProject,
  type Taskset,
} from "@openpond/contracts";
import { TasksetReleaseSchema, type TasksetRelease } from "@openpond/evals";
import { z } from "zod";

import type { SqliteStore } from "../store/store.js";
import { hostedApiAuthHeaders } from "../openpond/hosted-api-access.js";

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

export function createModelProjectHostingService(input: {
  store: SqliteStore;
  resolveAccess: () => Promise<HostedAccess>;
  env?: NodeJS.ProcessEnv;
  fetch?: typeof fetch;
}) {
  const fetchImpl = input.fetch ?? fetch;

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
      trainingSetup: project.trainingSetup,
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
    headers.set("accept", "application/json");
    headers.set(
      "content-type",
      request.gzip
        ? PORTABLE_TASKSET_PUBLICATION_CONTENT_TYPE
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
          typeof payload.error === "string"
            ? payload.error
            : "Hosted Model Project request failed"
        } (${response.status} ${endpoint.origin}${endpoint.pathname}).`,
      );
    }
    return payload as T;
  }

  return { publishTaskset, syncProject };

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

function upsertTasksetSync(
  entries: ModelProject["tasksetSyncs"],
  entry: ModelProject["tasksetSyncs"][number],
): ModelProject["tasksetSyncs"] {
  return [
    ...entries.filter((candidate) => candidate.localTasksetId !== entry.localTasksetId),
    entry,
  ];
}

function errorMessage(value: unknown): string {
  return value instanceof Error ? value.message : String(value);
}

function isProjectSyncConflict(value: unknown): boolean {
  return errorMessage(value).startsWith("model_project_sync_conflict (");
}

async function requireProject(
  store: SqliteStore,
  projectId: string,
): Promise<ModelProject> {
  const project = await store.getModelProject(projectId);
  if (!project) throw new Error("Model Project was not found.");
  return project;
}

function buildIntent(
  taskset: Taskset,
): "demonstrations" | "preferences" | "verifiable_reward" | "rubric" | "discovery" {
  if (taskset.preferenceComparison) return "preferences";
  if (taskset.graders.some((grader) => grader.kind === "human")) return "preferences";
  if (taskset.graders.some((grader) => grader.rewardEligible)) {
    return "verifiable_reward";
  }
  return "discovery";
}
import { gzipSync } from "node:zlib";
