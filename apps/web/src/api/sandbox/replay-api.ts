import type {
  SandboxReplayArtifactsResponse,
  SandboxReplayInput,
  SandboxReplayListResponse,
  SandboxReplayLogsResponse,
  SandboxReplayResponse,
} from "../../lib/sandbox-types";
import {
  apiFetch,
  type ClientConnection,
} from "../api-client";

export const sandboxReplayApi = {
  sandboxReplays: (
    connection: ClientConnection,
    input: {
      teamId?: string;
      projectId?: string;
    } = {},
  ) => {
    const query = new URLSearchParams();
    if (input.teamId) query.set("teamId", input.teamId);
    if (input.projectId) query.set("projectId", input.projectId);
    return apiFetch<SandboxReplayListResponse>(
      connection,
      `/v1/sandbox-replays${query.size > 0 ? `?${query.toString()}` : ""}`,
    );
  },
  startSandboxReplay: (
    connection: ClientConnection,
    input: SandboxReplayInput & { teamId?: string; projectId?: string },
  ) => {
    const query = new URLSearchParams();
    if (input.teamId) query.set("teamId", input.teamId);
    if (input.projectId) query.set("projectId", input.projectId);
    const { teamId: _teamId, projectId: _projectId, ...body } = input;
    return apiFetch<SandboxReplayResponse>(
      connection,
      `/v1/sandbox-replays${query.size > 0 ? `?${query.toString()}` : ""}`,
      {
        method: "POST",
        body: JSON.stringify(body),
      },
    );
  },
  sandboxReplay: (
    connection: ClientConnection,
    replayId: string,
    input: {
      teamId?: string;
      projectId?: string;
    } = {},
  ) => {
    const query = new URLSearchParams();
    if (input.teamId) query.set("teamId", input.teamId);
    if (input.projectId) query.set("projectId", input.projectId);
    return apiFetch<SandboxReplayResponse>(
      connection,
      `/v1/sandbox-replays/${encodeURIComponent(replayId)}${
        query.size > 0 ? `?${query.toString()}` : ""
      }`,
    );
  },
  sandboxReplayLogs: (
    connection: ClientConnection,
    replayId: string,
    input: {
      teamId?: string;
      projectId?: string;
    } = {},
  ) => {
    const query = new URLSearchParams();
    if (input.teamId) query.set("teamId", input.teamId);
    if (input.projectId) query.set("projectId", input.projectId);
    return apiFetch<SandboxReplayLogsResponse>(
      connection,
      `/v1/sandbox-replays/${encodeURIComponent(replayId)}/logs${
        query.size > 0 ? `?${query.toString()}` : ""
      }`,
    );
  },
  sandboxReplayArtifacts: (
    connection: ClientConnection,
    replayId: string,
    input: {
      teamId?: string;
      projectId?: string;
    } = {},
  ) => {
    const query = new URLSearchParams();
    if (input.teamId) query.set("teamId", input.teamId);
    if (input.projectId) query.set("projectId", input.projectId);
    return apiFetch<SandboxReplayArtifactsResponse>(
      connection,
      `/v1/sandbox-replays/${encodeURIComponent(replayId)}/artifacts${
        query.size > 0 ? `?${query.toString()}` : ""
      }`,
    );
  },
  cancelSandboxReplay: (
    connection: ClientConnection,
    replayId: string,
    input: {
      teamId?: string;
      projectId?: string;
    } = {},
  ) => {
    const query = new URLSearchParams();
    if (input.teamId) query.set("teamId", input.teamId);
    if (input.projectId) query.set("projectId", input.projectId);
    return apiFetch<SandboxReplayResponse>(
      connection,
      `/v1/sandbox-replays/${encodeURIComponent(replayId)}/cancel${
        query.size > 0 ? `?${query.toString()}` : ""
      }`,
      {
        method: "POST",
      },
    );
  },
};
