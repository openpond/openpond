import type { ModelProject } from "@openpond/contracts";
import {
  createModelProjectsClient,
  HostedModelProjectSummarySchema,
  type HostedModelProjectSummary,
} from "openpond-sdk/model-projects";
import { z } from "zod";

import { hostedApiAuthHeaders } from "../openpond/hosted-api-access.js";
import type { SqliteStore } from "../store/store.js";

type HostedAccess = {
  apiBaseUrl: string;
  token: string;
  teamId: string;
};

const HOSTED_MODEL_PROJECT_CATALOG_CACHE_TYPE =
  "training.hosted-model-project-catalog.v1";

const HostedModelProjectCatalogCacheSchema = z.object({
  teamId: z.string().min(1),
  projects: z.array(HostedModelProjectSummarySchema),
  generatedAt: z.string().datetime({ offset: true }),
});

export type HostedModelProjectLocalState =
  | "not_pulled"
  | "up_to_date"
  | "remote_ahead"
  | "local_ahead"
  | "diverged"
  | "local_conflict";

export type HostedModelProjectCatalogItem = {
  project: HostedModelProjectSummary;
  localProjectId: string | null;
  localRevision: number | null;
  localState: HostedModelProjectLocalState;
};

export async function listHostedModelProjectCatalog(
  input: {
    store: SqliteStore;
    resolveAccess: () => Promise<HostedAccess>;
    fetch: typeof fetch;
  },
  options: { refresh?: boolean } = {},
): Promise<{
  teamId: string;
  projects: HostedModelProjectCatalogItem[];
  generatedAt: string;
  cached: boolean;
}> {
  const access = await input.resolveAccess();
  const cacheKey = `${access.apiBaseUrl}|${access.teamId}`;
  const cachedEntry = options.refresh
    ? null
    : await input.store.getCacheEntry<unknown>(
        HOSTED_MODEL_PROJECT_CATALOG_CACHE_TYPE,
        cacheKey,
      );
  const cached = cachedEntry
    ? HostedModelProjectCatalogCacheSchema.safeParse(cachedEntry.payload)
    : null;
  const useCached = Boolean(cached?.success);
  const catalog = cached?.success
    ? cached.data
    : await refreshHostedProjectCatalog(input, access, cacheKey);
  const localProjects = await input.store.listModelProjects();
  const localById = new Map(
    localProjects.map((project) => [project.id, project] as const),
  );
  return {
    teamId: access.teamId,
    projects: catalog.projects.map((project) => {
      const local = localById.get(project.portableProjectId) ?? null;
      return {
        project,
        localProjectId: local?.id ?? null,
        localRevision: local?.revision ?? null,
        localState: hostedProjectLocalState(project, local, access.teamId),
      };
    }),
    generatedAt: catalog.generatedAt,
    cached: useCached,
  };
}

async function refreshHostedProjectCatalog(
  input: { store: SqliteStore; fetch: typeof fetch },
  access: HostedAccess,
  cacheKey: string,
) {
  const headers = hostedApiAuthHeaders(access.token);
  headers.set("x-openpond-team-id", access.teamId);
  const client = createModelProjectsClient({
    baseUrl: access.apiBaseUrl,
    fetch: input.fetch,
    headers,
  });
  const catalog = HostedModelProjectCatalogCacheSchema.parse({
    teamId: access.teamId,
    projects: await client.list(),
    generatedAt: new Date().toISOString(),
  });
  await input.store.setCacheEntry(
    HOSTED_MODEL_PROJECT_CATALOG_CACHE_TYPE,
    cacheKey,
    catalog,
  );
  return catalog;
}

function hostedProjectLocalState(
  hosted: HostedModelProjectSummary,
  local: ModelProject | null,
  teamId: string,
): HostedModelProjectLocalState {
  if (!local) return "not_pulled";
  if (
    local.hosted?.teamId !== teamId ||
    local.hosted.projectId !== hosted.id ||
    local.hosted.portableProjectId !== hosted.portableProjectId
  ) {
    return "local_conflict";
  }
  const localChanged = local.revision !== local.hosted.syncedSourceRevision;
  const remoteChanged = local.hosted.etag !== hosted.etag;
  if (localChanged && remoteChanged) return "diverged";
  if (localChanged) return "local_ahead";
  if (remoteChanged || local.revision !== hosted.sourceRevision) {
    return "remote_ahead";
  }
  return "up_to_date";
}
