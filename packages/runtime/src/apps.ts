import {
  createRepo,
  getOpenPondAccount,
  listApps,
} from "@openpond/cloud";
import type { CreateRepoRequest, CreateRepoResponse, OpenPondAccountResponse } from "@openpond/cloud";
import { SandboxAppActionRegistrySchema, type OpenPondApp } from "@openpond/contracts";
import type {
  AccountLoadResult,
  AppsLoadResult,
  RuntimeAccountContext,
} from "./types.js";
import { toAccountState } from "./account-state.js";
import { loadOpenPondAccountContext } from "./account-context.js";
import { errorMessage } from "./errors.js";
import { accountToken, profileKey } from "./selectors.js";
import { resolvePublicApiBaseUrl } from "./urls.js";

export type LoadOpenPondAppsOptions = {
  limit?: number;
  offset?: number;
  includeScheduled?: boolean;
};

function normalizeApp(input: unknown): OpenPondApp | null {
  if (!input || typeof input !== "object") return null;
  const item = input as Record<string, unknown>;
  const id = typeof item.id === "string" ? item.id : null;
  const name = typeof item.name === "string" ? item.name : id;
  if (!id || !name) return null;
  const deployment =
    item.latestDeployment && typeof item.latestDeployment === "object"
      ? (item.latestDeployment as Record<string, unknown>)
      : null;
  const registryResult = SandboxAppActionRegistrySchema.safeParse(item.sandboxActionRegistry);
  return {
    id,
    name,
    description: typeof item.description === "string" ? item.description : null,
    visibility: typeof item.visibility === "string" ? item.visibility : null,
    gitOwner: typeof item.gitOwner === "string" ? item.gitOwner : null,
    gitRepo: typeof item.gitRepo === "string" ? item.gitRepo : null,
    gitHost: typeof item.gitHost === "string" ? item.gitHost : null,
    defaultBranch: typeof item.defaultBranch === "string" ? item.defaultBranch : null,
    sandbox: item.sandbox === true,
    sandboxActionRegistry: registryResult.success ? registryResult.data : null,
    sandboxManifestHash: typeof item.sandboxManifestHash === "string" ? item.sandboxManifestHash : null,
    sandboxManifestPath: typeof item.sandboxManifestPath === "string" ? item.sandboxManifestPath : null,
    sandboxManifestSyncedAt:
      typeof item.sandboxManifestSyncedAt === "string"
        ? item.sandboxManifestSyncedAt
        : item.sandboxManifestSyncedAt instanceof Date
          ? item.sandboxManifestSyncedAt.toISOString()
          : null,
    sandboxManifestError: typeof item.sandboxManifestError === "string" ? item.sandboxManifestError : null,
    updatedAt: typeof item.updatedAt === "string" ? item.updatedAt : null,
    latestDeployment: deployment
      ? {
          id: typeof deployment.id === "string" ? deployment.id : undefined,
          status: typeof deployment.status === "string" ? deployment.status : undefined,
          deploymentDomain: typeof deployment.deploymentDomain === "string" ? deployment.deploymentDomain : null,
          createdAt: typeof deployment.createdAt === "string" ? deployment.createdAt : undefined,
          isProduction: typeof deployment.isProduction === "boolean" ? deployment.isProduction : null,
          gitBranch: typeof deployment.gitBranch === "string" ? deployment.gitBranch : null,
        }
      : null,
    scheduleSummary: normalizeScheduleSummary(item.scheduleSummary),
  };
}

function normalizeDateString(value: unknown): string | null {
  if (typeof value === "string") return value;
  if (value instanceof Date) return value.toISOString();
  return null;
}

function normalizeSchedule(input: unknown) {
  if (!input || typeof input !== "object") return null;
  const item = input as Record<string, unknown>;
  const id = typeof item.id === "string" ? item.id : null;
  const name = typeof item.name === "string" ? item.name : id;
  const deploymentId = typeof item.deploymentId === "string" ? item.deploymentId : null;
  if (!id || !name || !deploymentId) return null;
  return {
    id,
    name,
    description: typeof item.description === "string" ? item.description : null,
    scheduleType: typeof item.scheduleType === "string" ? item.scheduleType : "cron",
    scheduleExpression: typeof item.scheduleExpression === "string" ? item.scheduleExpression : "",
    enabled: Boolean(item.enabled),
    rawEnabled: typeof item.rawEnabled === "boolean" ? item.rawEnabled : undefined,
    syncStatus: typeof item.syncStatus === "string" ? item.syncStatus : null,
    syncError: typeof item.syncError === "string" ? item.syncError : null,
    startAt: normalizeDateString(item.startAt),
    endAt: normalizeDateString(item.endAt),
    maxRuns: typeof item.maxRuns === "number" ? item.maxRuns : null,
    executionCount: typeof item.executionCount === "number" ? item.executionCount : null,
    lifecycleStatus: typeof item.lifecycleStatus === "string" ? item.lifecycleStatus : null,
    lifecycleReason: typeof item.lifecycleReason === "string" ? item.lifecycleReason : null,
    lastExecutionAt: normalizeDateString(item.lastExecutionAt),
    lastExecutionStatus: typeof item.lastExecutionStatus === "string" ? item.lastExecutionStatus : null,
    lastRunNowAt: normalizeDateString(item.lastRunNowAt),
    lastRunNowStatus: typeof item.lastRunNowStatus === "string" ? item.lastRunNowStatus : null,
    updatedAt: normalizeDateString(item.updatedAt) ?? new Date().toISOString(),
    deploymentId,
    isProduction: typeof item.isProduction === "boolean" ? item.isProduction : undefined,
    payload: item.payload,
  };
}

function normalizeScheduleSummary(input: unknown): OpenPondApp["scheduleSummary"] {
  if (!input || typeof input !== "object") return null;
  const item = input as Record<string, unknown>;
  const schedules = Array.isArray(item.schedules)
    ? item.schedules.map(normalizeSchedule).filter((value): value is NonNullable<ReturnType<typeof normalizeSchedule>> => Boolean(value))
    : [];
  const total = typeof item.total === "number" ? item.total : schedules.length;
  const active = typeof item.active === "number" ? item.active : schedules.filter((schedule) => schedule.enabled).length;
  const paused = typeof item.paused === "number" ? item.paused : Math.max(0, total - active);
  return {
    total,
    active,
    paused,
    enabled: typeof item.enabled === "number" ? item.enabled : active,
    disabled: typeof item.disabled === "number" ? item.disabled : paused,
    nextRunAt: normalizeDateString(item.nextRunAt),
    lastRunAt: normalizeDateString(item.lastRunAt),
    schedules,
    truncated: typeof item.truncated === "boolean" ? item.truncated : undefined,
  };
}

type AccountProfileLookup = {
  response: OpenPondAccountResponse | null;
  authFailed: boolean;
  error: string | null;
};

async function loadAccountProfileLookups(context: RuntimeAccountContext): Promise<Record<string, AccountProfileLookup>> {
  const accounts = Array.isArray(context.config.accounts) ? context.config.accounts : [];
  const entries = await Promise.all(
    accounts.map(async (account) => {
      const key = profileKey(account.handle, account.baseUrl);
      const token = accountToken(account);
      if (!token) {
        return [
          key,
          { response: null, authFailed: false, error: null },
        ] as const;
      }
      try {
        return [
          key,
          {
            response: await getOpenPondAccount(resolvePublicApiBaseUrl(account, context.config), token),
            authFailed: false,
            error: null,
          },
        ] as const;
      } catch (error) {
        return [
          key,
          {
            response: null,
            authFailed: true,
            error: errorMessage(error),
          },
        ] as const;
      }
    })
  );
  return Object.fromEntries(entries);
}

async function loadOpenPondAccountStateForContext(
  context: RuntimeAccountContext
): Promise<AccountLoadResult> {
  const accountProfiles = await loadAccountProfileLookups(context);
  const activeLookup = context.account
    ? accountProfiles[
        profileKey(context.account.handle, context.account.baseUrl)
      ] ?? null
    : null;
  const accountResponse = activeLookup?.response ?? null;
  const authError =
    context.token && activeLookup?.authFailed
      ? activeLookup.error || "OpenPond account authentication failed."
      : null;
  return {
    account: toAccountState({
      ...context,
      accountResponse,
      accountProfiles,
      authFailed: Boolean(authError),
      error: authError,
    }),
  };
}

export async function loadOpenPondAccountState(): Promise<AccountLoadResult> {
  return loadOpenPondAccountStateForContext(
    await loadOpenPondAccountContext()
  );
}

export async function loadOpenPondApps(
  options: LoadOpenPondAppsOptions = {}
): Promise<AppsLoadResult> {
  const context = await loadOpenPondAccountContext();
  const accountPromise = loadOpenPondAccountStateForContext(context);
  if (!context.token) {
    return {
      ...(await accountPromise),
      apps: [],
      error: "No OpenPond API key or session token is configured.",
    };
  }

  const [accountResult, appsResult] = await Promise.allSettled([
    accountPromise,
    listApps(context.apiBaseUrl, context.token, {
      handle: context.account?.handle,
      limit: options.limit ?? 20,
      offset: options.offset ?? 0,
      includeScheduled: options.includeScheduled ?? true,
    }),
  ]);
  if (accountResult.status === "rejected") throw accountResult.reason;
  return {
    account: accountResult.value.account,
    apps:
      appsResult.status === "fulfilled"
        ? (appsResult.value as unknown[])
            .map(normalizeApp)
            .filter((value): value is OpenPondApp => Boolean(value))
        : [],
    error:
      appsResult.status === "rejected" ? errorMessage(appsResult.reason) : null,
  };
}

export async function createOpenPondRepoApp(
  input: CreateRepoRequest
): Promise<{ response: CreateRepoResponse; account: Awaited<ReturnType<typeof loadOpenPondAccountContext>> }> {
  const context = await loadOpenPondAccountContext();
  if (!context.token) {
    throw new Error("No OpenPond API key or session token is configured.");
  }
  return {
    account: context,
    response: await createRepo(context.apiBaseUrl, context.token, input),
  };
}
