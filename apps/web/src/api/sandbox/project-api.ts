import type {
  SandboxAgentRunInput,
  SandboxAgentRunResponse,
  SandboxAgentListResponse,
  SandboxAgentResponse,
  SandboxAgentUpsertInput,
  CreateSandboxRequest,
  SandboxProjectListResponse,
  SandboxProjectResponse,
  SandboxProjectSourceUploadInput,
  SandboxProjectUpsertInput,
  SandboxRecordResponse,
} from "../../lib/sandbox-types";
import {
  apiFetch,
  type ClientConnection,
} from "../api-client";

export const sandboxProjectApi = {
  createSandbox: (connection: ClientConnection, input: CreateSandboxRequest) =>
    apiFetch<SandboxRecordResponse>(connection, "/v1/sandboxes", {
      method: "POST",
      body: JSON.stringify(input),
    }),
  listSandboxProjects: (connection: ClientConnection, input: { teamId: string }) => {
    const query = new URLSearchParams({ teamId: input.teamId });
    return apiFetch<SandboxProjectListResponse>(
      connection,
      `/v1/sandbox-projects?${query.toString()}`,
    );
  },
  upsertSandboxProject: (connection: ClientConnection, input: SandboxProjectUpsertInput) =>
    apiFetch<SandboxProjectResponse>(connection, "/v1/sandbox-projects", {
      method: "POST",
      body: JSON.stringify(input),
    }),
  sandboxProject: (connection: ClientConnection, projectId: string, input: { teamId: string }) => {
    const query = new URLSearchParams({ teamId: input.teamId });
    return apiFetch<SandboxProjectResponse>(
      connection,
      `/v1/sandbox-projects/${encodeURIComponent(projectId)}?${query.toString()}`,
    );
  },
  syncSandboxProject: (
    connection: ClientConnection,
    projectId: string,
    input: { teamId: string },
  ) => {
    const query = new URLSearchParams({ teamId: input.teamId });
    return apiFetch<SandboxProjectResponse>(
      connection,
      `/v1/sandbox-projects/${encodeURIComponent(projectId)}/sync?${query.toString()}`,
      { method: "POST" },
    );
  },
  uploadSandboxProjectSource: (
    connection: ClientConnection,
    projectId: string,
    input: SandboxProjectSourceUploadInput,
  ) => {
    const query = new URLSearchParams({ teamId: input.teamId });
    const { teamId: _teamId, ...body } = input;
    return apiFetch<SandboxProjectResponse>(
      connection,
      `/v1/sandbox-projects/${encodeURIComponent(projectId)}/source?${query.toString()}`,
      {
        method: "POST",
        body: JSON.stringify(body),
      },
    );
  },
  archiveSandboxProject: (
    connection: ClientConnection,
    projectId: string,
    input: { teamId: string },
  ) => {
    const query = new URLSearchParams({ teamId: input.teamId });
    return apiFetch<SandboxProjectResponse>(
      connection,
      `/v1/sandbox-projects/${encodeURIComponent(projectId)}?${query.toString()}`,
      { method: "DELETE" },
    );
  },
  listSandboxAgents: (connection: ClientConnection, input: { teamId: string }) => {
    const query = new URLSearchParams({ teamId: input.teamId });
    return apiFetch<SandboxAgentListResponse>(
      connection,
      `/v1/sandbox-agents?${query.toString()}`,
    );
  },
  upsertSandboxAgent: (connection: ClientConnection, input: SandboxAgentUpsertInput) =>
    apiFetch<SandboxAgentResponse>(connection, "/v1/sandbox-agents", {
      method: "POST",
      body: JSON.stringify(input),
    }),
  sandboxAgent: (connection: ClientConnection, agentId: string, input: { teamId: string }) => {
    const query = new URLSearchParams({ teamId: input.teamId });
    return apiFetch<SandboxAgentResponse>(
      connection,
      `/v1/sandbox-agents/${encodeURIComponent(agentId)}?${query.toString()}`,
    );
  },
	  runSandboxAgent: (
	    connection: ClientConnection,
	    agentId: string,
	    input: SandboxAgentRunInput,
	  ) =>
    apiFetch<SandboxAgentRunResponse>(
      connection,
      `/v1/sandbox-agents/${encodeURIComponent(agentId)}/run`,
      {
        method: "POST",
        body: JSON.stringify(input),
	      },
	    ),
	  runProfileAction: (
	    connection: ClientConnection,
	    input: { action: string; input?: Record<string, unknown>; metadata?: Record<string, unknown> },
	  ) =>
	    apiFetch<{ action: string; stdout: string; stderr: string; code: number | null }>(
	      connection,
	      "/v1/profile/run",
	      {
	        method: "POST",
	        body: JSON.stringify(input),
	      },
	    ),
	  archiveSandboxAgent: (
    connection: ClientConnection,
    agentId: string,
    input: { teamId: string },
  ) => {
    const query = new URLSearchParams({ teamId: input.teamId });
    return apiFetch<SandboxAgentResponse>(
      connection,
      `/v1/sandbox-agents/${encodeURIComponent(agentId)}?${query.toString()}`,
      { method: "DELETE" },
    );
  },
};
