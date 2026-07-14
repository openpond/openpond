import type {
  ConnectedAppStatusResponse,
} from "@openpond/contracts";
import type {
  SandboxIntegrationConnectionLeaseInput,
  SandboxIntegrationConnectionsResponse,
  SandboxIntegrationConnectionStatusFilter,
  SandboxIntegrationLeasesResponse,
  SandboxSecretListResponse,
  SandboxSecretResponse,
} from "../../lib/sandbox-types";
import {
  apiFetch,
  sandboxScopeQuery,
  type ClientConnection,
  type SandboxScopeInput,
} from "../api-client";

export const sandboxIntegrationApi = {
  connectedAppStatus: (
    connection: ClientConnection,
    input: {
      teamId?: string;
      projectId?: string;
      agentId?: string;
      status?: SandboxIntegrationConnectionStatusFilter;
    } = {},
  ) => {
    const query = sandboxScopeQuery(input);
    query.set("status", input.status ?? "all");
    return apiFetch<ConnectedAppStatusResponse>(
      connection,
      `/v1/connected-apps/status${query.size > 0 ? `?${query.toString()}` : ""}`,
    );
  },
  integrationConnections: (
    connection: ClientConnection,
    input: {
      teamId?: string;
      projectId?: string;
      agentId?: string;
      status?: SandboxIntegrationConnectionStatusFilter;
    } = {},
  ) => {
    const query = sandboxScopeQuery(input);
    if (input.status) query.set("status", input.status);
    return apiFetch<SandboxIntegrationConnectionsResponse>(
      connection,
      `/v1/integrations/connections${query.size > 0 ? `?${query.toString()}` : ""}`,
    );
  },
  sandboxIntegrationLeases: (connection: ClientConnection, sandboxId: string) =>
    apiFetch<SandboxIntegrationLeasesResponse>(
      connection,
      `/v1/sandboxes/${encodeURIComponent(sandboxId)}/integrations`,
    ),
  attachSandboxIntegrationConnection: (
    connection: ClientConnection,
    sandboxId: string,
    input: SandboxIntegrationConnectionLeaseInput,
  ) =>
    apiFetch<SandboxIntegrationLeasesResponse>(
      connection,
      `/v1/sandboxes/${encodeURIComponent(sandboxId)}/integrations`,
      {
        method: "POST",
        body: JSON.stringify(input),
      },
    ),
  removeSandboxIntegrationLease: (
    connection: ClientConnection,
    sandboxId: string,
    leaseId: string,
  ) =>
    apiFetch<SandboxIntegrationLeasesResponse>(
      connection,
      `/v1/sandboxes/${encodeURIComponent(sandboxId)}/integrations`,
      {
        method: "DELETE",
        body: JSON.stringify({ leaseId }),
      },
    ),
  sandboxSecrets: (
    connection: ClientConnection,
    input: SandboxScopeInput = {},
  ) => {
    const query = sandboxScopeQuery(input);
    return apiFetch<SandboxSecretListResponse>(
      connection,
      `/v1/sandbox-secrets${query.size > 0 ? `?${query.toString()}` : ""}`,
    );
  },
  sandboxSecret: (
    connection: ClientConnection,
    secretId: string,
    input: SandboxScopeInput = {},
  ) => {
    const query = sandboxScopeQuery(input);
    return apiFetch<SandboxSecretResponse>(
      connection,
      `/v1/sandbox-secrets/${encodeURIComponent(secretId)}${
        query.size > 0 ? `?${query.toString()}` : ""
      }`,
    );
  },
  createSandboxSecret: (
    connection: ClientConnection,
    input: {
      teamId?: string;
      name: string;
      value: string;
      description?: string;
      scope?: "team" | "app" | "project" | "template";
    },
  ) =>
    apiFetch<SandboxSecretResponse>(connection, "/v1/sandbox-secrets", {
      method: "POST",
      body: JSON.stringify(input),
    }),
  rotateSandboxSecret: (
    connection: ClientConnection,
    secretId: string,
    input: { teamId?: string; value: string },
  ) =>
    apiFetch<SandboxSecretResponse>(
      connection,
      `/v1/sandbox-secrets/${encodeURIComponent(secretId)}/rotate`,
      {
        method: "POST",
        body: JSON.stringify(input),
      },
    ),
};
