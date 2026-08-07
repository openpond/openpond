import {
  createOpenPondSandboxClient,
  normalizeSandboxApiUrl,
} from "@openpond/cloud/sandbox/client";
import type {
  OpenPondOrganization,
  SandboxIntegrationConnection,
  SandboxIntegrationConnectionStatusFilter,
} from "@openpond/cloud/sandbox/types";
import { loadOpenPondAccountContext } from "@openpond/runtime";

export async function listAppServerIntegrationConnections(input: {
  teamId?: string;
  status?: SandboxIntegrationConnectionStatusFilter;
}): Promise<{
  teamId: string | null;
  connections: SandboxIntegrationConnection[];
}> {
  const context = await loadOpenPondAccountContext();
  const apiKey =
    process.env.OPENPOND_SANDBOX_API_KEY?.trim() ||
    process.env.OPENPOND_API_KEY?.trim() ||
    context.token?.trim();
  if (!apiKey) {
    throw new Error(
      "OpenPond account API key is required to resolve connected apps.",
    );
  }
  const sandboxApiUrl = process.env.OPENPOND_SANDBOX_API_URL?.trim();
  const client = createOpenPondSandboxClient({
    apiKey,
    ...(sandboxApiUrl
      ? { sandboxApiUrl: normalizeSandboxApiUrl(sandboxApiUrl) }
      : { baseUrl: context.apiBaseUrl }),
  });
  const status = input.status ?? "active";
  if (input.teamId?.trim()) {
    return client.integrationConnections({
      teamId: input.teamId.trim(),
      status,
    });
  }

  const organizations = await client.listOrganizations();
  const teamIds = activeTeamIds(organizations);
  if (teamIds.length === 0) return { teamId: null, connections: [] };
  const results = await Promise.all(
    teamIds.map((teamId) =>
      client.integrationConnections({ teamId, status }).catch(() => null),
    ),
  );
  const successful = results.filter(
    (result): result is NonNullable<typeof result> => Boolean(result),
  );
  return {
    teamId:
      successful.find((result) => result.connections.length > 0)?.teamId ??
      successful[0]?.teamId ??
      teamIds[0] ??
      null,
    connections: mergeConnections(successful),
  };
}

function activeTeamIds(organizations: OpenPondOrganization[]): string[] {
  return Array.from(
    new Set(
      organizations.flatMap((organization) => {
        if (
          typeof organization.status === "string" &&
          organization.status !== "active"
        ) {
          return [];
        }
        const legacyId = (organization as { id?: unknown }).id;
        const teamId =
          typeof organization.teamId === "string"
            ? organization.teamId
            : typeof legacyId === "string"
              ? legacyId
              : "";
        return teamId.trim() ? [teamId.trim()] : [];
      }),
    ),
  );
}

function mergeConnections(
  results: Array<{ connections: SandboxIntegrationConnection[] }>,
): SandboxIntegrationConnection[] {
  const connections = new Map<string, SandboxIntegrationConnection>();
  for (const result of results) {
    for (const connection of result.connections) {
      connections.set(connection.id, connection);
    }
  }
  return [...connections.values()];
}
