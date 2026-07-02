import {
  getDeploymentLogs,
  getDeploymentStatus,
  listApps,
  listUserTools,
  type AppListItem,
} from "../../api";
import {
  DEFAULT_CACHE_TTL_MS,
  getCachedApps,
  getCachedTools,
  setCachedApps,
  setCachedTools,
} from "../../cache";
import { normalizeRepoName, parseHandleRepo } from "./repo-format";

export async function fetchAppsWithCache(params: {
  apiBase: string;
  apiKey: string;
  forceRefresh?: boolean;
}): Promise<AppListItem[]> {
  if (!params.forceRefresh) {
    const cached = await getCachedApps({
      apiBase: params.apiBase,
      apiKey: params.apiKey,
      ttlMs: DEFAULT_CACHE_TTL_MS,
    });
    if (cached) {
      return cached;
    }
  }
  const apps = await listApps(params.apiBase, params.apiKey);
  await setCachedApps({
    apiBase: params.apiBase,
    apiKey: params.apiKey,
    apps,
  });
  return apps;
}

export async function fetchToolsWithCache(params: {
  apiBase: string;
  apiKey: string;
  forceRefresh?: boolean;
}): Promise<unknown[]> {
  if (!params.forceRefresh) {
    const cached = await getCachedTools({
      apiBase: params.apiBase,
      apiKey: params.apiKey,
      ttlMs: DEFAULT_CACHE_TTL_MS,
    });
    if (cached) {
      return cached;
    }
  }
  const result = await listUserTools(params.apiBase, params.apiKey);
  const tools = Array.isArray(result.tools) ? result.tools : [];
  await setCachedTools({
    apiBase: params.apiBase,
    apiKey: params.apiKey,
    tools,
  });
  return tools;
}

export async function resolveAppTarget(
  apiBase: string,
  apiKey: string,
  target: string
): Promise<{ app: AppListItem; handle: string; repo: string }> {
  const { handle, repo } = parseHandleRepo(target);
  const apps = await fetchAppsWithCache({ apiBase, apiKey });
  const normalizedRepo = normalizeRepoName(repo);
  const match = apps.find((app) => {
    if (app.handle && app.handle !== handle) {
      return false;
    }
    const candidates = [app.repo, app.gitRepo, app.id].map(normalizeRepoName);
    return candidates.includes(normalizedRepo);
  });
  if (!match) {
    throw new Error(`app not found for ${handle}/${repo}`);
  }
  return { app: match, handle, repo };
}

export async function pollDeploymentLogs(params: {
  baseUrl: string;
  apiKey: string;
  deploymentId: string;
  prefix: string;
  intervalMs?: number;
  timeoutMs?: number;
}): Promise<void> {
  const intervalMs = params.intervalMs ?? 5000;
  const timeoutMs = params.timeoutMs ?? 4 * 60 * 1000;
  const seen = new Set<string>();
  const startedAt = Date.now();

  while (Date.now() - startedAt < timeoutMs) {
    const logs = await getDeploymentLogs(
      params.baseUrl,
      params.apiKey,
      params.deploymentId
    );
    const newLogs = logs.filter((log) => !seen.has(log.id));
    for (const log of newLogs) {
      seen.add(log.id);
    }
    for (const log of newLogs) {
      console.log(`${params.prefix}${log.message}`);
    }

    const status = await getDeploymentStatus(
      params.baseUrl,
      params.apiKey,
      params.deploymentId
    );
    if (status.status === "failed") {
      console.log(`${params.prefix}deployment failed`);
      return;
    }
    if (status.status === "running" || status.status === "deployed") {
      console.log(`${params.prefix}deployment complete`);
      return;
    }

    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }

  console.log(`${params.prefix}deployment still in progress`);
}
