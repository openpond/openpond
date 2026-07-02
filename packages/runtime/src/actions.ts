import {
  deleteOrArchiveSchedule,
  deployApp,
  getAppEnvironment,
  getAppExecutionTimeline,
  getDeploymentStatus,
  getAppRuntimeSummary,
  getLatestDeploymentForApp,
  listAppSchedules,
  listDeploymentScheduleExecutionLogs,
  listScheduleExecutionLogs,
  promotePreviewToProduction,
  runScheduleNow,
  startAppLifecycle,
  startAppSchedules,
  stopAppSchedules,
  updateAppEnvironment,
  type AppExecutionTimelineResponse,
  type AppEnvironmentGetResponse,
  type AppEnvironmentUpdateResponse,
  type AppSchedulesResponse,
  type PromotePreviewToProductionResponse,
  type ScheduleDeleteResponse,
  type ScheduleExecutionLogsResponse,
  type ScheduleRunNowResponse,
  type ScheduleToggleResult,
  type StartAppLifecycleResponse,
} from "@openpond/cloud";
import type { OpenPondActionResult } from "./types.js";
import { loadOpenPondAccountContext } from "./account-context.js";
import { loadOpenPondApps } from "./apps.js";

export async function runOpenPondStatusAction(action: string, appId?: string | null): Promise<OpenPondActionResult> {
  const context = await loadOpenPondAccountContext();
  if (!context.token) {
    return {
      ok: false,
      action,
      appId: appId ?? null,
      output: "OpenPond is signed out. Add an account in Settings before running app actions.",
    };
  }

  if (action === "refresh.apps") {
    const result = await loadOpenPondApps();
    return {
      ok: !result.error,
      action,
      appId: null,
      output: result.error
        ? `OpenPond app refresh failed: ${result.error}`
        : `Loaded ${result.apps.length} OpenPond app${result.apps.length === 1 ? "" : "s"}.`,
      data: result.apps,
    };
  }

  if (!appId) {
    return {
      ok: false,
      action,
      appId: null,
      output: "Select an OpenPond app before running this action.",
    };
  }

  if (action === "app.summary") {
    const summary = await getAppRuntimeSummary(context.apiBaseUrl, context.token, appId);
    const appName = summary.app?.name || appId;
    const deployment = summary.runtime?.latestDeployment;
    return {
      ok: true,
      action,
      appId,
      relatedDeploymentId: deployment?.id,
      output: `${appName}: ${deployment?.status ?? "no deployment"}; schedules ${summary.runtime?.schedules?.enabled ?? 0}/${summary.runtime?.schedules?.total ?? 0} enabled.`,
      data: summary,
    };
  }

  if (action === "latest_deployment") {
    const deployment = await getLatestDeploymentForApp(context.apiBaseUrl, context.token, appId);
    return {
      ok: true,
      action,
      appId,
      relatedDeploymentId: deployment?.id,
      output: deployment?.id
        ? `Latest deployment ${deployment.id} is ${deployment.status ?? "unknown"}.`
        : "No latest deployment was returned for this app.",
      data: deployment,
    };
  }

  if (action === "schedules.list") {
    const schedules = await listAppSchedules(context.apiBaseUrl, context.token, appId);
    const count = Array.isArray(schedules.schedules) ? schedules.schedules.length : 0;
    return {
      ok: true,
      action,
      appId,
      output: `Loaded ${count} schedule${count === 1 ? "" : "s"} for this app.`,
      data: schedules,
    };
  }

  return {
    ok: false,
    action,
    appId,
    output: `Unknown OpenPond action: ${action}`,
  };
}

export async function deployOpenPondApp(input: {
  appId: string;
  environment: "preview" | "production";
  branch: string;
  commitSha: string;
}): Promise<{
  deploymentId: string;
  environment?: "preview" | "production";
  url?: string;
  version?: number;
  commitSha?: string;
}> {
  const context = await loadOpenPondAccountContext();
  if (!context.token) {
    throw new Error("OpenPond is signed out. Add an account before deploying.");
  }
  return deployApp(context.apiBaseUrl, context.token, input.appId, {
    environment: input.environment,
    branch: input.branch,
    commitSha: input.commitSha,
  });
}

export async function promoteOpenPondPreviewToProduction(input: {
  appId: string;
  previewDeploymentId?: string;
  baseBranch: string;
  headBranch: string;
  chatRunId?: string;
}): Promise<PromotePreviewToProductionResponse> {
  const context = await loadOpenPondAccountContext();
  if (!context.token) {
    throw new Error("OpenPond is signed out. Add an account before promoting deployments.");
  }
  return promotePreviewToProduction(context.apiBaseUrl, context.token, input.appId, {
    previewDeploymentId: input.previewDeploymentId,
    baseBranch: input.baseBranch,
    headBranch: input.headBranch,
    chatRunId: input.chatRunId,
  });
}

export async function startOpenPondAppLifecycle(input: {
  appId: string;
  previewDeploymentId?: string;
  deploymentId?: string;
  baseBranch?: string;
  headBranch?: string;
  chatRunId?: string;
  scheduleId?: string | null;
  preferredScheduleId?: string | null;
  startAt?: string | Date | null;
  endAt?: string | Date | null;
  promotePreview?: boolean;
  deployToProduction?: boolean;
  runOnceImmediately?: boolean;
  runImmediately?: boolean;
}): Promise<StartAppLifecycleResponse> {
  const context = await loadOpenPondAccountContext();
  if (!context.token) {
    throw new Error("OpenPond is signed out. Add an account before starting apps.");
  }
  const { appId, ...rest } = input;
  return startAppLifecycle(context.apiBaseUrl, context.token, appId, rest);
}

export async function getOpenPondDeploymentStatus(input: {
  appId: string;
  deploymentId?: string | null;
}): Promise<unknown> {
  const context = await loadOpenPondAccountContext();
  if (!context.token) {
    throw new Error("OpenPond is signed out. Add an account before checking deployments.");
  }
  if (input.deploymentId?.trim()) {
    return {
      deploymentId: input.deploymentId.trim(),
      ...(await getDeploymentStatus(context.apiBaseUrl, context.token, input.deploymentId.trim())),
    };
  }
  return getLatestDeploymentForApp(context.apiBaseUrl, context.token, input.appId);
}

export async function getOpenPondAppEnvironment(input: {
  appId: string;
}): Promise<AppEnvironmentGetResponse> {
  const context = await loadOpenPondAccountContext();
  if (!context.token) {
    throw new Error("OpenPond is signed out. Add an account before reading app config.");
  }
  return getAppEnvironment(context.apiBaseUrl, context.token, input.appId);
}

export async function updateOpenPondAppEnvironment(input: {
  appId: string;
  envVars: Record<string, string>;
}): Promise<AppEnvironmentUpdateResponse> {
  const context = await loadOpenPondAccountContext();
  if (!context.token) {
    throw new Error("OpenPond is signed out. Add an account before updating app config.");
  }
  const existing = await getAppEnvironment(context.apiBaseUrl, context.token, input.appId);
  return updateAppEnvironment(context.apiBaseUrl, context.token, input.appId, {
    envVars: {
      ...(existing.environment ?? {}),
      ...input.envVars,
    },
  });
}

export async function startOpenPondAppSchedules(input: {
  appId: string;
  scheduleId?: string | null;
  preferredScheduleId?: string | null;
  startAt?: string | Date | null;
  endAt?: string | Date | null;
}): Promise<ScheduleToggleResult> {
  const context = await loadOpenPondAccountContext();
  if (!context.token) {
    throw new Error("OpenPond is signed out. Add an account before starting schedules.");
  }
  return startAppSchedules(context.apiBaseUrl, context.token, input.appId, {
    preferredScheduleId: input.preferredScheduleId?.trim() || input.scheduleId?.trim() || null,
    scheduleId: input.scheduleId?.trim() || null,
    startAt: input.startAt,
    endAt: input.endAt,
  });
}

export async function listOpenPondAppSchedules(input: {
  appId: string;
}): Promise<AppSchedulesResponse> {
  const context = await loadOpenPondAccountContext();
  if (!context.token) {
    throw new Error("OpenPond is signed out. Add an account before reading schedules.");
  }
  return listAppSchedules(context.apiBaseUrl, context.token, input.appId);
}

export async function stopOpenPondAppSchedules(input: { appId: string }): Promise<ScheduleToggleResult> {
  const context = await loadOpenPondAccountContext();
  if (!context.token) {
    throw new Error("OpenPond is signed out. Add an account before stopping schedules.");
  }
  return stopAppSchedules(context.apiBaseUrl, context.token, input.appId);
}

export async function runOpenPondScheduleNow(input: {
  scheduleId: string;
}): Promise<ScheduleRunNowResponse> {
  const context = await loadOpenPondAccountContext();
  if (!context.token) {
    throw new Error("OpenPond is signed out. Add an account before running schedules.");
  }
  return runScheduleNow(context.apiBaseUrl, context.token, {
    scheduleId: input.scheduleId,
  });
}

export async function deleteOpenPondSchedule(input: {
  appId: string;
  scheduleId: string;
}): Promise<ScheduleDeleteResponse> {
  const context = await loadOpenPondAccountContext();
  if (!context.token) {
    throw new Error("OpenPond is signed out. Add an account before deleting schedules.");
  }
  return deleteOrArchiveSchedule(
    context.apiBaseUrl,
    context.token,
    input.appId,
    input.scheduleId
  );
}

export async function listOpenPondScheduleExecutionLogs(input: {
  scheduleId: string;
  limit?: number;
}): Promise<ScheduleExecutionLogsResponse> {
  const context = await loadOpenPondAccountContext();
  if (!context.token) {
    throw new Error("OpenPond is signed out. Add an account before reading schedule logs.");
  }
  return listScheduleExecutionLogs(context.apiBaseUrl, context.token, input.scheduleId, {
    limit: input.limit,
  });
}

export async function listOpenPondDeploymentScheduleExecutionLogs(input: {
  deploymentId: string;
  limit?: number;
}): Promise<ScheduleExecutionLogsResponse> {
  const context = await loadOpenPondAccountContext();
  if (!context.token) {
    throw new Error("OpenPond is signed out. Add an account before reading schedule logs.");
  }
  return listDeploymentScheduleExecutionLogs(
    context.apiBaseUrl,
    context.token,
    input.deploymentId,
    { limit: input.limit }
  );
}

export async function getOpenPondAppExecutionTimeline(input: {
  appId: string;
  limit?: number;
}): Promise<AppExecutionTimelineResponse> {
  const context = await loadOpenPondAccountContext();
  if (!context.token) {
    throw new Error("OpenPond is signed out. Add an account before reading execution history.");
  }
  return getAppExecutionTimeline(context.apiBaseUrl, context.token, input.appId, {
    limit: input.limit,
  });
}
