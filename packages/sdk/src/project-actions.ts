import { promises as fs } from "node:fs";

import { apiFetch, readApiJson } from "@openpond/cloud/api/core";

import type { ProjectActionBuildResult, ProjectActionRegistry } from "../../actions/src/types.js";

export type ProjectActionRelease = {
  id: string;
  projectId: string;
  sourceCommitSha: string;
  bundleHash: string;
  registryHash: string;
  status: string;
  createdAt: string;
};

export type HostedProjectActionCatalog = {
  releaseId: string;
  sourceCommitSha: string;
  bundleHash: string;
  registryHash: string;
  registry: ProjectActionRegistry;
};

export type ProjectActionInvocation<TOutput = Record<string, unknown>> = {
  id: string;
  releaseId: string;
  projectId: string;
  actionId: string;
  status: "running" | "succeeded" | "failed";
  resultJson: TOutput;
  traceJson: Record<string, unknown>[];
  outputJson: Record<string, unknown>[];
  failureCode?: string | null;
  failureMessage?: string | null;
};

type ProjectActionClientInput = {
  apiKey: string;
  apiBaseUrl: string;
};

export class OpenPondProjectActionsClient {
  readonly #apiKey: string;
  readonly #apiBaseUrl: string;

  constructor(input: ProjectActionClientInput) {
    this.#apiKey = input.apiKey;
    this.#apiBaseUrl = input.apiBaseUrl.replace(/\/+$/, "");
  }

  async list(input: { projectId: string; teamId: string }): Promise<ProjectActionRelease[]> {
    const response = await apiFetch(
      this.#apiBaseUrl,
      this.#apiKey,
      projectActionPath(input.projectId, "releases", input.teamId),
    );
    return (await readApiJson<{ releases: ProjectActionRelease[] }>(response, "List Project Action releases")).releases;
  }

  async catalog(input: { projectId: string; teamId: string }): Promise<HostedProjectActionCatalog> {
    const response = await apiFetch(
      this.#apiBaseUrl,
      this.#apiKey,
      projectActionPath(input.projectId, "catalog", input.teamId),
    );
    return (await readApiJson<{ catalog: HostedProjectActionCatalog }>(response, "Get Project Action catalog")).catalog;
  }

  async publish(input: {
    projectId: string;
    teamId: string;
    sourceRef: string;
    sourceCommitSha: string;
    build: ProjectActionBuildResult;
    metadata?: Record<string, unknown>;
  }): Promise<ProjectActionRelease> {
    const [bundle, runner] = await Promise.all([
      fs.readFile(input.build.bundlePath),
      fs.readFile(input.build.runnerPath),
    ]);
    const response = await apiFetch(
      this.#apiBaseUrl,
      this.#apiKey,
      projectActionPath(input.projectId, "releases", input.teamId),
      {
        method: "POST",
        body: JSON.stringify({
          sourceRef: input.sourceRef,
          sourceCommitSha: input.sourceCommitSha,
          bundleBase64: bundle.toString("base64"),
          runnerBase64: runner.toString("base64"),
          registry: input.build.registry,
          manifest: input.build.manifest,
          metadata: input.metadata,
        }),
      },
    );
    return (await readApiJson<{ release: ProjectActionRelease }>(response, "Publish Project Actions")).release;
  }

  async run<TOutput = Record<string, unknown>>(input: {
    projectId: string;
    teamId: string;
    actionId: string;
    value?: Record<string, unknown>;
    releaseId?: string;
    idempotencyKey?: string;
    callerType?: "sdk" | "work" | "scheduled_work" | "website" | "internal";
    callerId?: string;
    signal?: AbortSignal;
  }): Promise<ProjectActionInvocation<TOutput>> {
    const response = await apiFetch(
      this.#apiBaseUrl,
      this.#apiKey,
      projectActionPath(input.projectId, `actions/${encodeURIComponent(input.actionId)}`, input.teamId),
      {
        method: "POST",
        body: JSON.stringify({
          input: input.value ?? {},
          releaseId: input.releaseId,
          idempotencyKey: input.idempotencyKey,
          callerType: input.callerType ?? "sdk",
          callerId: input.callerId,
        }),
        signal: input.signal,
        timeoutMs: 15 * 60 * 1000,
      },
    );
    return (await readApiJson<{ invocation: ProjectActionInvocation<TOutput> }>(response, "Run Project Action")).invocation;
  }
}

function projectActionPath(projectId: string, suffix: string, teamId: string): string {
  return `/v1/project-actions/${encodeURIComponent(projectId)}/${suffix}?teamId=${encodeURIComponent(teamId)}`;
}
