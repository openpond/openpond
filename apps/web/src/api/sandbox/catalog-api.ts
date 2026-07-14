import type {
  SandboxListResponse,
  SandboxSnapshotCatalogResponse,
  SandboxVolumeCreateInput,
  SandboxVolumeListResponse,
  SandboxVolumeResponse,
} from "../../lib/sandbox-types";
import {
  apiFetch,
  sandboxScopeQuery,
  type ClientConnection,
  type SandboxScopeInput,
} from "../api-client";

export const sandboxCatalogApi = {
  sandboxes: (
    connection: ClientConnection,
    input: SandboxScopeInput = {},
  ) => {
    const query = sandboxScopeQuery(input);
    return apiFetch<SandboxListResponse>(
      connection,
      `/v1/sandboxes${query.size > 0 ? `?${query.toString()}` : ""}`,
    );
  },
  sandboxVolumes: (
    connection: ClientConnection,
    input: SandboxScopeInput = {},
  ) => {
    const query = sandboxScopeQuery(input);
    return apiFetch<SandboxVolumeListResponse>(
      connection,
      `/v1/sandboxes/volumes${query.size > 0 ? `?${query.toString()}` : ""}`,
    );
  },
  createSandboxVolume: (connection: ClientConnection, input: SandboxVolumeCreateInput) =>
    apiFetch<SandboxVolumeResponse>(connection, "/v1/sandboxes/volumes", {
      method: "POST",
      body: JSON.stringify(input),
    }),
  deleteSandboxVolume: (
    connection: ClientConnection,
    volumeId: string,
    input: SandboxScopeInput = {},
  ) => {
    const query = sandboxScopeQuery(input);
    return apiFetch<SandboxVolumeResponse>(
      connection,
      `/v1/sandboxes/volumes/${encodeURIComponent(volumeId)}${
        query.size > 0 ? `?${query.toString()}` : ""
      }`,
      { method: "DELETE" },
    );
  },
  sandboxSnapshotCatalog: (
    connection: ClientConnection,
    input: {
      teamId?: string;
      projectId?: string;
      agentId?: string;
      q?: string;
      replayState?: "draft" | "validated" | "published";
      tag?: string;
      useCase?: string;
    } = {},
  ) => {
    const query = sandboxScopeQuery(input);
    if (input.q) query.set("q", input.q);
    if (input.replayState) query.set("replayState", input.replayState);
    if (input.tag) query.set("tag", input.tag);
    if (input.useCase) query.set("useCase", input.useCase);
    return apiFetch<SandboxSnapshotCatalogResponse>(
      connection,
      `/v1/sandboxes/snapshots${query.size > 0 ? `?${query.toString()}` : ""}`,
    );
  },
};
