import { withVercelProtectionBypass } from "@openpond/cloud";
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
    const hosted = await requestJson<{ project: unknown }>({
      access,
      pathname: `/v1/model-projects/${encodeURIComponent(project.id)}`,
      method: "PUT",
      body: {
        schemaVersion: "openpond.hostedModelProjectSync.v1",
        portableProjectId: project.id,
        name: project.name,
        objective: project.objective,
        defaultBaseModel: project.defaultBaseModel,
        defaultDestinationId: project.defaultDestinationId,
        sourceRevision: project.revision,
        sourceUpdatedAt: project.updatedAt,
        expectedEtag: project.hosted?.etag ?? null,
      },
    });
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
    const project = await syncProject(inputValue.projectId);
    if (!project.hosted) throw new Error("Hosted Model Project link was not persisted.");
    const access = await input.resolveAccess();
    if (project.hosted.teamId !== access.teamId) {
      throw new Error("Model Project is linked to a different hosted workspace.");
    }
    const response = await requestJson<{ project: unknown; taskset: unknown }>({
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
    });
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
    });
    await input.store.saveModelProject(saved);
    return saved;
  }

  async function requestJson<T>(request: {
    access: HostedAccess;
    pathname: string;
    method: "POST" | "PUT";
    body: unknown;
  }): Promise<T> {
    const url = `${request.access.apiBaseUrl}${request.pathname}`;
    const headers = withVercelProtectionBypass(
      url,
      hostedApiAuthHeaders(request.access.token),
      input.env ?? process.env,
    );
    headers.set("accept", "application/json");
    headers.set("content-type", "application/json");
    headers.set("x-openpond-team-id", request.access.teamId);
    const response = await fetchImpl(url, {
      method: request.method,
      headers,
      body: JSON.stringify(request.body),
    });
    const payload = (await response.json().catch(() => ({}))) as Record<
      string,
      unknown
    >;
    if (!response.ok) {
      throw new Error(
        typeof payload.error === "string"
          ? payload.error
          : `Hosted Model Project request failed (${response.status}).`,
      );
    }
    return payload as T;
  }

  return { publishTaskset, syncProject };
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
