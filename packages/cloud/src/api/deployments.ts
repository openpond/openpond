import { apiFetch, readApiJson } from "./core.js";
import type {
  DeploymentDetail,
  DeploymentLogEntry,
  PromotePreviewToProductionRequest,
  PromotePreviewToProductionResponse,
  StartAppLifecycleRequest,
  StartAppLifecycleResponse,
} from "./types.js";

export async function commitFiles(
  baseUrl: string,
  token: string,
  appId: string,
  files: Record<string, string>,
  commitMessage: string
): Promise<{ commitSha: string }> {
  const response = await apiFetch(baseUrl, token, `/v4/apps/${appId}/commits`, {
    method: "POST",
    body: JSON.stringify({ files, message: commitMessage }),
  });
  if (!response.ok) {
    const text = await response.text().catch(() => "");
    throw new Error(`Commit failed: ${response.status} ${text}`);
  }
  return (await response.json()) as { commitSha: string };
}

export async function deployApp(
  baseUrl: string,
  token: string,
  appId: string,
  input?: {
    environment?: "preview" | "production";
    commitSha?: string;
    branch?: string;
  }
): Promise<{
  deploymentId: string;
  environment?: "preview" | "production";
  url?: string;
  version?: number;
  commitSha?: string;
}> {
  const environment = input?.environment ?? "production";
  const response = await apiFetch(
    baseUrl,
    token,
    `/v4/apps/${appId}/deployments`,
    {
      method: "POST",
      body: JSON.stringify({
        environment,
        ...(input?.commitSha ? { commitSha: input.commitSha } : {}),
        ...(input?.branch ? { branch: input.branch } : {}),
      }),
    }
  );
  if (!response.ok) {
    const text = await response.text().catch(() => "");
    throw new Error(`Deploy failed: ${response.status} ${text}`);
  }
  return (await response.json()) as { deploymentId: string };
}

export async function promotePreviewToProduction(
  baseUrl: string,
  token: string,
  appId: string,
  input: PromotePreviewToProductionRequest
): Promise<PromotePreviewToProductionResponse> {
  const response = await apiFetch(
    baseUrl,
    token,
    `/v4/apps/${encodeURIComponent(appId)}/deployments/promote-preview`,
    {
      method: "POST",
      body: JSON.stringify(input),
    }
  );
  return readApiJson<PromotePreviewToProductionResponse>(
    response,
    "Preview promotion"
  );
}

export async function startAppLifecycle(
  baseUrl: string,
  token: string,
  appId: string,
  input: StartAppLifecycleRequest
): Promise<StartAppLifecycleResponse> {
  const response = await apiFetch(
    baseUrl,
    token,
    `/v1/apps/${encodeURIComponent(appId)}/lifecycle/start`,
    {
      method: "POST",
      body: JSON.stringify(input),
    }
  );
  return readApiJson<StartAppLifecycleResponse>(
    response,
    "App lifecycle start"
  );
}

export async function getDeploymentLogs(
  apiBase: string,
  token: string,
  deploymentId: string
): Promise<DeploymentLogEntry[]> {
  const response = await apiFetch(
    apiBase,
    token,
    `/apps/deployments/${deploymentId}/logs`,
    { method: "GET" }
  );
  if (!response.ok) {
    const text = await response.text().catch(() => "");
    throw new Error(`Deployment logs failed: ${response.status} ${text}`);
  }
  const payload = (await response.json().catch(() => ({}))) as {
    logs?: Array<{
      id?: string;
      type?: string;
      message?: string;
      createdAt?: string | Date;
    }>;
  };
  const logs = Array.isArray(payload.logs) ? payload.logs : [];
  return logs.map((log) => {
    const createdAt =
      typeof log.createdAt === "string"
        ? log.createdAt
        : log.createdAt instanceof Date
        ? log.createdAt.toISOString()
        : new Date().toISOString();
    return {
      id: typeof log.id === "string" ? log.id : `${Math.random()}`,
      type: typeof log.type === "string" ? log.type : undefined,
      message: typeof log.message === "string" ? log.message : "",
      createdAt,
    };
  });
}

export async function getDeploymentStatus(
  apiBase: string,
  token: string,
  deploymentId: string
): Promise<{ status?: string }> {
  const response = await apiFetch(
    apiBase,
    token,
    `/apps/deployments/${deploymentId}/status`,
    { method: "GET" }
  );
  if (!response.ok) {
    const text = await response.text().catch(() => "");
    throw new Error(`Deployment status failed: ${response.status} ${text}`);
  }
  const payload = (await response.json().catch(() => ({}))) as {
    deployment?: { status?: string };
  };
  return { status: payload.deployment?.status };
}

export async function getLatestDeploymentForApp(
  apiBase: string,
  token: string,
  appId: string,
  options?: { status?: string[]; createdAfter?: string; branch?: string }
): Promise<{ id?: string; status?: string } | null> {
  const params = new URLSearchParams();
  if (options?.status && options.status.length > 0) {
    params.set("status", options.status.join(","));
  }
  if (options?.createdAfter) {
    params.set("createdAfter", options.createdAfter);
  }
  if (options?.branch) {
    params.set("branch", options.branch);
  }
  const query = params.toString();
  const response = await apiFetch(
    apiBase,
    token,
    `/apps/${appId}/deployments/latest${query ? `?${query}` : ""}`,
    { method: "GET" }
  );
  if (!response.ok) {
    const text = await response.text().catch(() => "");
    throw new Error(
      `Latest deployment lookup failed: ${response.status} ${text}`
    );
  }
  const payload = (await response.json().catch(() => ({}))) as {
    deployment?: { id?: string; status?: string } | null;
  };
  if (!payload.deployment) return null;
  return {
    id: payload.deployment.id,
    status: payload.deployment.status,
  };
}

export async function getDeploymentDetail(
  apiBase: string,
  token: string,
  deploymentId: string
): Promise<DeploymentDetail | null> {
  const response = await apiFetch(
    apiBase,
    token,
    `/apps/deployments/${deploymentId}`,
    { method: "GET" }
  );
  if (!response.ok) {
    const text = await response.text().catch(() => "");
    throw new Error(`Deployment fetch failed: ${response.status} ${text}`);
  }
  const payload = (await response.json().catch(() => ({}))) as {
    deployment?: DeploymentDetail | null;
  };
  return payload.deployment ?? null;
}
