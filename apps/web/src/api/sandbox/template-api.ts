import type {
  LaunchSandboxTemplateRequest,
  SandboxTemplateBuildCreateInput,
  SandboxTemplateBuildListResponse,
  SandboxTemplateBuildLogsResponse,
  SandboxTemplateBuildResponse,
  SandboxTemplateCatalogResponse,
  SandboxTemplateLaunchResponse,
} from "../../lib/sandbox-types";
import {
  apiFetch,
  type ClientConnection,
} from "../api-client";

export const sandboxTemplateApi = {
  sandboxTemplates: (
    connection: ClientConnection,
    input: {
      teamId?: string;
      projectId?: string;
      q?: string;
      name?: string;
      version?: string;
      tag?: string;
      useCase?: string;
    } = {},
  ) => {
    const query = new URLSearchParams();
    if (input.teamId) query.set("teamId", input.teamId);
    if (input.projectId) query.set("projectId", input.projectId);
    if (input.q) query.set("q", input.q);
    if (input.name) query.set("name", input.name);
    if (input.version) query.set("version", input.version);
    if (input.tag) query.set("tag", input.tag);
    if (input.useCase) query.set("useCase", input.useCase);
    return apiFetch<SandboxTemplateCatalogResponse>(
      connection,
      `/v1/sandboxes/templates${query.size > 0 ? `?${query.toString()}` : ""}`,
    );
  },
  sandboxTemplateBuilds: (
    connection: ClientConnection,
    input: {
      teamId: string;
    },
  ) => {
    const query = new URLSearchParams({ teamId: input.teamId });
    return apiFetch<SandboxTemplateBuildListResponse>(
      connection,
      `/v1/sandbox-template-builds?${query.toString()}`,
    );
  },
  createSandboxTemplateBuild: (
    connection: ClientConnection,
    input: SandboxTemplateBuildCreateInput,
  ) =>
    apiFetch<SandboxTemplateBuildResponse>(connection, "/v1/sandbox-template-builds", {
      method: "POST",
      body: JSON.stringify(input),
    }),
  sandboxTemplateBuild: (connection: ClientConnection, buildId: string) =>
    apiFetch<SandboxTemplateBuildResponse>(
      connection,
      `/v1/sandbox-template-builds/${encodeURIComponent(buildId)}`,
    ),
  sandboxTemplateBuildLogs: (connection: ClientConnection, buildId: string) =>
    apiFetch<SandboxTemplateBuildLogsResponse>(
      connection,
      `/v1/sandbox-template-builds/${encodeURIComponent(buildId)}/logs`,
    ),
  cancelSandboxTemplateBuild: (connection: ClientConnection, buildId: string) =>
    apiFetch<SandboxTemplateBuildResponse>(
      connection,
      `/v1/sandbox-template-builds/${encodeURIComponent(buildId)}/cancel`,
      {
        method: "POST",
      },
    ),
  launchSandboxTemplate: (
    connection: ClientConnection,
    input: LaunchSandboxTemplateRequest,
  ) => {
    const query = new URLSearchParams();
    if (input.teamId) query.set("teamId", input.teamId);
    if (input.projectId) query.set("projectId", input.projectId);
    const { teamId: _teamId, projectId: _projectId, ...body } = input;
    return apiFetch<SandboxTemplateLaunchResponse>(
      connection,
      `/v1/sandboxes/templates/launch${query.size > 0 ? `?${query.toString()}` : ""}`,
      {
        method: "POST",
        body: JSON.stringify(body),
      },
    );
  },
};
