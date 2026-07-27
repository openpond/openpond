import type {
  SandboxIntegrationConnectionLeaseInput,
  SandboxIntegrationConnectionsResponse,
  SandboxIntegrationConnectionStatusFilter,
  SandboxIntegrationLeasesResponse,
} from "../../lib/sandbox-types";
import {
  apiFetch,
  sandboxScopeQuery,
  type ClientConnection,
} from "../api-client";

export const sandboxIntegrationApi = {
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
};
