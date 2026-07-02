import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

export type LocalSessionConfig = {
  token?: string;
  appId?: string | null;
  conversationId?: string | null;
};

export type LocalAccountConfig = {
  handle: string;
  apiKey?: string;
  baseUrl?: string;
  apiBaseUrl?: string;
  chatApiBaseUrl?: string;
  environment?: string;
  session?: LocalSessionConfig;
};

export type ActiveProfileSelector = {
  handle: string;
  baseUrl?: string | null;
};

export type LocalOpenPondProfileCheckStatus = {
  command: "inspect" | "build" | "validate" | "eval" | "run";
  status: "passed" | "failed";
  checkedAt: string;
  exitCode?: number | null;
  sourceHead?: string | null;
};

export type LocalOpenPondProfileHostedSourceCheckStatus = {
  status: string;
  agentId?: string | null;
  workItemId?: string | null;
  deployPlanStatus?: string | null;
  canRun?: boolean | null;
  canDeploy?: boolean | null;
  sourceRef?: string | null;
  sourceCommitSha?: string | null;
  manifestHash?: string | null;
  manifestPath?: string | null;
  setupCommands?: string[];
  validationCommands?: string[];
  requiredChecks?: string[];
  evalNames?: string[];
  blockedReasons?: string[];
  staleReasons?: string[];
  runtimeId?: string | null;
  sandboxId?: string | null;
  traceArtifactRefs?: string[];
  evalResultArtifactRefs?: string[];
  validatorArtifactRefs?: string[];
  checkedAt?: string | null;
  error?: string | null;
};

export type LocalOpenPondProfileHostedMaterializationStatus = {
  status: string;
  agentId?: string | null;
  runtimeAgentId?: string | null;
  projectId?: string | null;
  sourceRoot?: string | null;
  sourceRef?: string | null;
  sourceCommitSha?: string | null;
  manifestHash?: string | null;
  manifestPath?: string | null;
  manifestSyncedAt?: string | null;
  fileCount?: number | null;
  totalBytes?: number | null;
  generatedManifestPath?: string | null;
  synthesizedOpenPondYaml?: boolean | null;
  uploadMetadataPath?: string | null;
  setupCommands?: string[];
  validationCommands?: string[];
  materializedAt?: string | null;
  error?: string | null;
};

export type LocalOpenPondProfileHostedPublishStatus = {
  status: string;
  agentId?: string | null;
  snapshotId?: string | null;
  sourceRef?: string | null;
  sourceCommitSha?: string | null;
  manifestHash?: string | null;
  manifestPath?: string | null;
  buildStatus?: string | null;
  validationStatus?: string | null;
  evalStatus?: string | null;
  publishedAt?: string | null;
  error?: string | null;
};

export type LocalOpenPondProfileHostedRunSummary = {
  status: string;
  agentId?: string | null;
  runId?: string | null;
  runtimeId?: string | null;
  sandboxId?: string | null;
  sourceRef?: string | null;
  sourceCommitSha?: string | null;
  manifestHash?: string | null;
  setupGateStatus?: string | null;
  setupRequirementRefs?: string[];
  artifactRefs?: string[];
  traceArtifactRefs?: string[];
  evalArtifactRefs?: string[];
  startedAt?: string | null;
  completedAt?: string | null;
  error?: string | null;
};

export type LocalOpenPondProfilePushStatus = {
  status: "pushed" | "failed";
  promotionStatus?: "uploaded" | "hosted_source_materialized" | "hosted_source_materialize_failed" | "hosted_source_check_pending" | "hosted_source_check_failed" | "hosted_source_published" | "hosted_source_publish_failed" | "hosted_run_pending" | "hosted_run_passed" | "hosted_run_failed" | null;
  hostedRunStatus?: "not_started" | "running" | "passed" | "failed" | null;
  pushedAt: string;
  teamId?: string | null;
  projectId?: string | null;
  localHead?: string | null;
  hostedHead?: string | null;
  sourceRef?: string | null;
  localGoalId?: string | null;
  hostedGoalId?: string | null;
  hostedRunAgentId?: string | null;
  hostedRunId?: string | null;
  hostedRunAt?: string | null;
  hostedSourceMaterialization?: LocalOpenPondProfileHostedMaterializationStatus | null;
  hostedSourceCheck?: LocalOpenPondProfileHostedSourceCheckStatus | null;
  hostedPublish?: LocalOpenPondProfileHostedPublishStatus | null;
  hostedRun?: LocalOpenPondProfileHostedRunSummary | null;
  error?: string | null;
};

export type LocalOpenPondProfileConfig = {
  repoPath: string;
  profile: string;
  mode: "local";
  lastCheck?: LocalOpenPondProfileCheckStatus;
  lastPush?: LocalOpenPondProfilePushStatus;
};

export type LocalGoalStorageLocation = "global" | "workspace";

export type LocalConfig = {
  accounts?: LocalAccountConfig[];
  activeProfile?: ActiveProfileSelector;
  openpondProfile?: LocalOpenPondProfileConfig;
  goalStorageLocation?: LocalGoalStorageLocation;
  baseUrl?: string;
  apiBaseUrl?: string;
  chatApiBaseUrl?: string;
  apiKey?: string;
  token?: string;
  appId?: string | null;
  conversationId?: string | null;
  lspEnabled?: boolean;
  executionMode?: "local" | "hosted";
  mode?: "general" | "builder";
};

export type ConfiguredProfile = {
  handle: string;
  baseUrl: string | null;
  apiBaseUrl: string | null;
  chatApiBaseUrl: string | null;
  environment: string | null;
  isActive: boolean;
  hasApiKey: boolean;
  hasSessionToken: boolean;
  sessionAppId: string | null;
  sessionConversationId: string | null;
};

export type SetActiveProfileOptions = {
  baseUrl?: string | null;
};

export type SaveProfileApiKeyInput = {
  handle: string;
  apiKey: string;
  baseUrl?: string | null;
  apiBaseUrl?: string | null;
  chatApiBaseUrl?: string | null;
  environment?: string | null;
  setActive?: boolean;
};

export type LoadConfigOptions = {
  account?: string;
  baseUrl?: string;
};

const GLOBAL_DIRNAME = ".openpond";
const GLOBAL_CONFIG_FILENAME = "config.json";
const DEFAULT_ACCOUNT_HANDLE = "default";
const ACCOUNT_SCOPED_KEYS = [
  "apiKey",
  "baseUrl",
  "apiBaseUrl",
  "chatApiBaseUrl",
  "token",
  "appId",
  "conversationId",
] as const;

export function getConfigPath(): string {
  return getGlobalConfigPath();
}

function getGlobalConfigPath(): string {
  return path.join(os.homedir(), GLOBAL_DIRNAME, GLOBAL_CONFIG_FILENAME);
}

async function loadConfigFile(filePath: string): Promise<LocalConfig> {
  try {
    const raw = await fs.readFile(filePath, "utf-8");
    return JSON.parse(raw) as LocalConfig;
  } catch {
    return {};
  }
}

function hasOwn<T extends object>(value: T, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(value, key);
}

function normalizeHandle(value: string | undefined | null): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function normalizeBaseUrl(value: string | undefined | null): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  return trimmed.replace(/\/$/, "");
}

function requireHandle(value: string | undefined | null): string {
  const handle = normalizeHandle(value);
  if (!handle) {
    throw new Error("profile handle must be non-empty");
  }
  return handle;
}

function requireApiKey(value: string | undefined | null): string {
  if (typeof value !== "string") {
    throw new Error("apiKey must be a non-empty string");
  }
  const trimmed = value.trim();
  if (!trimmed) {
    throw new Error("apiKey must be a non-empty string");
  }
  return trimmed;
}

function handleEquals(
  left: string | undefined | null,
  right: string | undefined | null
): boolean {
  const normalizedLeft = normalizeHandle(left);
  const normalizedRight = normalizeHandle(right);
  return Boolean(
    normalizedLeft &&
      normalizedRight &&
      normalizedLeft.toLowerCase() === normalizedRight.toLowerCase()
  );
}

function findAccountIndex(
  accounts: LocalAccountConfig[],
  handle: string,
  baseUrl?: string | null
): number {
  const normalizedBaseUrl = normalizeBaseUrl(baseUrl);
  return accounts.findIndex((candidate) => {
    if (!handleEquals(candidate.handle, handle)) return false;
    if (!normalizedBaseUrl) return true;
    return normalizeBaseUrl(candidate.baseUrl) === normalizedBaseUrl;
  });
}

function selectorFromAccount(
  account: LocalAccountConfig
): ActiveProfileSelector {
  const handle = normalizeHandle(account.handle) ?? DEFAULT_ACCOUNT_HANDLE;
  const baseUrl = normalizeBaseUrl(account.baseUrl);
  return baseUrl ? { handle, baseUrl } : { handle };
}

function sanitizeActiveProfile(value: unknown): ActiveProfileSelector | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const input = value as Record<string, unknown>;
  const handle = normalizeHandle(
    typeof input.handle === "string" ? input.handle : undefined
  );
  if (!handle) return null;

  const baseUrl = normalizeBaseUrl(
    typeof input.baseUrl === "string" ? input.baseUrl : undefined
  );
  return baseUrl ? { handle, baseUrl } : { handle };
}

function sanitizeLocalOpenPondProfile(
  value: unknown
): LocalOpenPondProfileConfig | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }
  const input = value as Record<string, unknown>;
  const repoPath =
    typeof input.repoPath === "string" ? input.repoPath.trim() : "";
  const profile =
    typeof input.profile === "string" && input.profile.trim()
      ? input.profile.trim()
      : "default";
  if (!repoPath) return undefined;
  const out: LocalOpenPondProfileConfig = {
    repoPath,
    profile,
    mode: "local",
  };
  if (
    input.lastCheck &&
    typeof input.lastCheck === "object" &&
    !Array.isArray(input.lastCheck)
  ) {
    const check = input.lastCheck as Record<string, unknown>;
    const command = check.command;
    const status = check.status;
    const checkedAt = check.checkedAt;
    if (
      (command === "inspect" ||
        command === "build" ||
        command === "validate" ||
        command === "eval" ||
        command === "run") &&
      (status === "passed" || status === "failed") &&
      typeof checkedAt === "string"
    ) {
      out.lastCheck = {
        command,
        status,
        checkedAt,
        ...(typeof check.exitCode === "number" || check.exitCode === null
          ? { exitCode: check.exitCode }
          : {}),
        ...(typeof check.sourceHead === "string" || check.sourceHead === null
          ? { sourceHead: check.sourceHead }
          : {}),
      };
    }
  }
  if (
    input.lastPush &&
    typeof input.lastPush === "object" &&
    !Array.isArray(input.lastPush)
  ) {
    const push = input.lastPush as Record<string, unknown>;
    const status = push.status;
    const pushedAt = push.pushedAt;
    if ((status === "pushed" || status === "failed") && typeof pushedAt === "string") {
      out.lastPush = {
        status,
        pushedAt,
        ...(typeof push.teamId === "string" || push.teamId === null
          ? { teamId: push.teamId }
          : {}),
        ...(typeof push.projectId === "string" || push.projectId === null
          ? { projectId: push.projectId }
          : {}),
        ...(typeof push.localHead === "string" || push.localHead === null
          ? { localHead: push.localHead }
          : {}),
        ...(typeof push.hostedHead === "string" || push.hostedHead === null
          ? { hostedHead: push.hostedHead }
          : {}),
        ...(typeof push.sourceRef === "string" || push.sourceRef === null
          ? { sourceRef: push.sourceRef }
          : {}),
        ...(push.promotionStatus === "uploaded" ||
        push.promotionStatus === "hosted_source_materialized" ||
        push.promotionStatus === "hosted_source_materialize_failed" ||
        push.promotionStatus === "hosted_source_check_pending" ||
        push.promotionStatus === "hosted_source_check_failed" ||
        push.promotionStatus === "hosted_source_published" ||
        push.promotionStatus === "hosted_source_publish_failed" ||
        push.promotionStatus === "hosted_run_pending" ||
        push.promotionStatus === "hosted_run_passed" ||
        push.promotionStatus === "hosted_run_failed" ||
        push.promotionStatus === null
          ? { promotionStatus: push.promotionStatus }
          : {}),
        ...(push.hostedRunStatus === "not_started" ||
        push.hostedRunStatus === "running" ||
        push.hostedRunStatus === "passed" ||
        push.hostedRunStatus === "failed" ||
        push.hostedRunStatus === null
          ? { hostedRunStatus: push.hostedRunStatus }
          : {}),
        ...(typeof push.localGoalId === "string" || push.localGoalId === null
          ? { localGoalId: push.localGoalId }
          : {}),
        ...(typeof push.hostedGoalId === "string" || push.hostedGoalId === null
          ? { hostedGoalId: push.hostedGoalId }
          : {}),
        ...(typeof push.hostedRunAgentId === "string" || push.hostedRunAgentId === null
          ? { hostedRunAgentId: push.hostedRunAgentId }
          : {}),
        ...(typeof push.hostedRunId === "string" || push.hostedRunId === null
          ? { hostedRunId: push.hostedRunId }
          : {}),
        ...(typeof push.hostedRunAt === "string" || push.hostedRunAt === null
          ? { hostedRunAt: push.hostedRunAt }
          : {}),
        ...(sanitizeHostedMaterializationStatus(push.hostedSourceMaterialization)
          ? { hostedSourceMaterialization: sanitizeHostedMaterializationStatus(push.hostedSourceMaterialization) }
          : {}),
        ...(sanitizeHostedSourceCheckStatus(push.hostedSourceCheck)
          ? { hostedSourceCheck: sanitizeHostedSourceCheckStatus(push.hostedSourceCheck) }
          : {}),
        ...(sanitizeHostedPublishStatus(push.hostedPublish)
          ? { hostedPublish: sanitizeHostedPublishStatus(push.hostedPublish) }
          : {}),
        ...(sanitizeHostedRunSummary(push.hostedRun)
          ? { hostedRun: sanitizeHostedRunSummary(push.hostedRun) }
          : {}),
        ...(typeof push.error === "string" || push.error === null
          ? { error: push.error }
          : {}),
      };
    }
  }
  return out;
}

function sanitizeHostedMaterializationStatus(
  value: unknown
): LocalOpenPondProfileHostedMaterializationStatus | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const input = value as Record<string, unknown>;
  const status = stringField(input.status);
  if (!status) return null;
  return {
    status,
    ...nullableStringProp(input, "agentId"),
    ...nullableStringProp(input, "runtimeAgentId"),
    ...nullableStringProp(input, "projectId"),
    ...nullableStringProp(input, "sourceRoot"),
    ...nullableStringProp(input, "sourceRef"),
    ...nullableStringProp(input, "sourceCommitSha"),
    ...nullableStringProp(input, "manifestHash"),
    ...nullableStringProp(input, "manifestPath"),
    ...nullableStringProp(input, "manifestSyncedAt"),
    ...nullableNumberProp(input, "fileCount"),
    ...nullableNumberProp(input, "totalBytes"),
    ...nullableStringProp(input, "generatedManifestPath"),
    ...nullableBooleanProp(input, "synthesizedOpenPondYaml"),
    ...nullableStringProp(input, "uploadMetadataPath"),
    ...stringArrayProp(input, "setupCommands"),
    ...stringArrayProp(input, "validationCommands"),
    ...nullableStringProp(input, "materializedAt"),
    ...nullableStringProp(input, "error"),
  };
}

function sanitizeHostedSourceCheckStatus(
  value: unknown
): LocalOpenPondProfileHostedSourceCheckStatus | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const input = value as Record<string, unknown>;
  const status = stringField(input.status);
  if (!status) return null;
  return {
    status,
    ...nullableStringProp(input, "agentId"),
    ...nullableStringProp(input, "workItemId"),
    ...nullableStringProp(input, "deployPlanStatus"),
    ...nullableBooleanProp(input, "canRun"),
    ...nullableBooleanProp(input, "canDeploy"),
    ...nullableStringProp(input, "sourceRef"),
    ...nullableStringProp(input, "sourceCommitSha"),
    ...nullableStringProp(input, "manifestHash"),
    ...nullableStringProp(input, "manifestPath"),
    ...stringArrayProp(input, "setupCommands"),
    ...stringArrayProp(input, "validationCommands"),
    ...stringArrayProp(input, "requiredChecks"),
    ...stringArrayProp(input, "evalNames"),
    ...stringArrayProp(input, "blockedReasons"),
    ...stringArrayProp(input, "staleReasons"),
    ...nullableStringProp(input, "runtimeId"),
    ...nullableStringProp(input, "sandboxId"),
    ...stringArrayProp(input, "traceArtifactRefs"),
    ...stringArrayProp(input, "evalResultArtifactRefs"),
    ...stringArrayProp(input, "validatorArtifactRefs"),
    ...nullableStringProp(input, "checkedAt"),
    ...nullableStringProp(input, "error"),
  };
}

function sanitizeHostedPublishStatus(
  value: unknown
): LocalOpenPondProfileHostedPublishStatus | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const input = value as Record<string, unknown>;
  const status = stringField(input.status);
  if (!status) return null;
  return {
    status,
    ...nullableStringProp(input, "agentId"),
    ...nullableStringProp(input, "snapshotId"),
    ...nullableStringProp(input, "sourceRef"),
    ...nullableStringProp(input, "sourceCommitSha"),
    ...nullableStringProp(input, "manifestHash"),
    ...nullableStringProp(input, "manifestPath"),
    ...nullableStringProp(input, "buildStatus"),
    ...nullableStringProp(input, "validationStatus"),
    ...nullableStringProp(input, "evalStatus"),
    ...nullableStringProp(input, "publishedAt"),
    ...nullableStringProp(input, "error"),
  };
}

function sanitizeHostedRunSummary(
  value: unknown
): LocalOpenPondProfileHostedRunSummary | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const input = value as Record<string, unknown>;
  const status = stringField(input.status);
  if (!status) return null;
  return {
    status,
    ...nullableStringProp(input, "agentId"),
    ...nullableStringProp(input, "runId"),
    ...nullableStringProp(input, "runtimeId"),
    ...nullableStringProp(input, "sandboxId"),
    ...nullableStringProp(input, "sourceRef"),
    ...nullableStringProp(input, "sourceCommitSha"),
    ...nullableStringProp(input, "manifestHash"),
    ...nullableStringProp(input, "setupGateStatus"),
    ...stringArrayProp(input, "setupRequirementRefs"),
    ...stringArrayProp(input, "artifactRefs"),
    ...stringArrayProp(input, "traceArtifactRefs"),
    ...stringArrayProp(input, "evalArtifactRefs"),
    ...nullableStringProp(input, "startedAt"),
    ...nullableStringProp(input, "completedAt"),
    ...nullableStringProp(input, "error"),
  };
}

function nullableStringProp<T extends string>(
  input: Record<string, unknown>,
  key: T
): Partial<Record<T, string | null>> {
  const value = input[key];
  return typeof value === "string" || value === null ? { [key]: value } as Partial<Record<T, string | null>> : {};
}

function nullableBooleanProp<T extends string>(
  input: Record<string, unknown>,
  key: T
): Partial<Record<T, boolean | null>> {
  const value = input[key];
  return typeof value === "boolean" || value === null ? { [key]: value } as Partial<Record<T, boolean | null>> : {};
}

function nullableNumberProp<T extends string>(
  input: Record<string, unknown>,
  key: T
): Partial<Record<T, number | null>> {
  const value = input[key];
  return typeof value === "number" || value === null ? { [key]: value } as Partial<Record<T, number | null>> : {};
}

function stringArrayProp<T extends string>(
  input: Record<string, unknown>,
  key: T
): Partial<Record<T, string[]>> {
  const value = input[key];
  if (!Array.isArray(value)) return {};
  const strings = value.filter((item): item is string => typeof item === "string");
  return { [key]: strings } as Partial<Record<T, string[]>>;
}

function stringField(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function accountMatchesSelector(
  account: LocalAccountConfig,
  selector: ActiveProfileSelector
): boolean {
  if (!handleEquals(account.handle, selector.handle)) return false;
  const selectorBaseUrl = normalizeBaseUrl(selector.baseUrl);
  if (selectorBaseUrl) {
    return normalizeBaseUrl(account.baseUrl) === selectorBaseUrl;
  }
  return !normalizeBaseUrl(account.baseUrl);
}

function findAccountIndexForSelector(
  accounts: LocalAccountConfig[],
  selector: ActiveProfileSelector,
  options: { requireUnambiguous?: boolean } = {}
): number {
  const normalizedBaseUrl = normalizeBaseUrl(selector.baseUrl);
  if (normalizedBaseUrl) {
    return findAccountIndex(accounts, selector.handle, normalizedBaseUrl);
  }

  const noBaseIdx = accounts.findIndex((account) =>
    accountMatchesSelector(account, selector)
  );
  if (noBaseIdx !== -1) return noBaseIdx;

  const matches = accounts
    .map((account, index) => ({ account, index }))
    .filter(({ account }) => handleEquals(account.handle, selector.handle));
  if (matches.length > 1 && options.requireUnambiguous) {
    throw new Error(
      `multiple profiles found for ${selector.handle}; pass --base-url to select one`
    );
  }
  return matches[0]?.index ?? -1;
}

function sanitizeSession(value: unknown): LocalSessionConfig | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }
  const input = value as Record<string, unknown>;
  const out: LocalSessionConfig = {};
  if (typeof input.token === "string") out.token = input.token;
  if (typeof input.appId === "string" || input.appId === null) {
    out.appId = input.appId;
  }
  if (
    typeof input.conversationId === "string" ||
    input.conversationId === null
  ) {
    out.conversationId = input.conversationId;
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

function sanitizeAccount(value: unknown): LocalAccountConfig | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const input = value as Record<string, unknown>;
  const handle = normalizeHandle(
    typeof input.handle === "string" ? input.handle : undefined
  );
  if (!handle) return null;

  const out: LocalAccountConfig = { handle };
  if (typeof input.apiKey === "string") out.apiKey = input.apiKey;
  if (typeof input.baseUrl === "string") out.baseUrl = input.baseUrl;
  if (typeof input.apiBaseUrl === "string") out.apiBaseUrl = input.apiBaseUrl;
  if (typeof input.chatApiBaseUrl === "string")
    out.chatApiBaseUrl = input.chatApiBaseUrl;
  if (typeof input.environment === "string")
    out.environment = input.environment;
  const session = sanitizeSession(input.session);
  if (session) out.session = session;
  return out;
}

function extractLegacySession(
  raw: LocalConfig
): LocalSessionConfig | undefined {
  const session: LocalSessionConfig = {};
  if (typeof raw.token === "string") session.token = raw.token;
  if (typeof raw.appId === "string" || raw.appId === null) {
    session.appId = raw.appId;
  }
  if (typeof raw.conversationId === "string" || raw.conversationId === null) {
    session.conversationId = raw.conversationId;
  }
  return Object.keys(session).length > 0 ? session : undefined;
}

function extractLegacyAccount(
  raw: LocalConfig,
  handle: string
): LocalAccountConfig {
  const out: LocalAccountConfig = { handle };
  if (typeof raw.apiKey === "string") out.apiKey = raw.apiKey;
  if (typeof raw.baseUrl === "string") out.baseUrl = raw.baseUrl;
  if (typeof raw.apiBaseUrl === "string") out.apiBaseUrl = raw.apiBaseUrl;
  if (typeof raw.chatApiBaseUrl === "string")
    out.chatApiBaseUrl = raw.chatApiBaseUrl;
  const session = extractLegacySession(raw);
  if (session) out.session = session;
  return out;
}

function normalizeGlobalConfig(raw: LocalConfig): LocalConfig {
  const normalized: LocalConfig = {};

  if (raw.goalStorageLocation === "global" || raw.goalStorageLocation === "workspace") {
    normalized.goalStorageLocation = raw.goalStorageLocation;
  }
  if (typeof raw.lspEnabled === "boolean")
    normalized.lspEnabled = raw.lspEnabled;
  if (raw.executionMode === "local" || raw.executionMode === "hosted") {
    normalized.executionMode = raw.executionMode;
  }
  if (raw.mode === "general" || raw.mode === "builder") {
    normalized.mode = raw.mode;
  }
  const openpondProfile = sanitizeLocalOpenPondProfile(raw.openpondProfile);
  if (openpondProfile) {
    normalized.openpondProfile = openpondProfile;
  }

  const accounts: LocalAccountConfig[] = [];
  const sourceAccounts = Array.isArray(raw.accounts) ? raw.accounts : [];
  for (const candidate of sourceAccounts) {
    const account = sanitizeAccount(candidate);
    if (!account) continue;
    if (findAccountIndex(accounts, account.handle, account.baseUrl) !== -1)
      continue;
    accounts.push(account);
  }

  if (accounts.length === 0) {
    const legacyHandle =
      sanitizeActiveProfile(raw.activeProfile)?.handle ||
      DEFAULT_ACCOUNT_HANDLE;
    accounts.push(extractLegacyAccount(raw, legacyHandle));
  }

  const requested = sanitizeActiveProfile(raw.activeProfile);
  const activeIdx = requested
    ? findAccountIndexForSelector(accounts, requested)
    : -1;
  const activeAccount = accounts[activeIdx === -1 ? 0 : activeIdx]!;

  normalized.accounts = accounts;
  normalized.activeProfile = selectorFromAccount(activeAccount);
  return normalized;
}

function resolveRequestedProfile(
  global: LocalConfig,
  explicitAccount?: string,
  explicitBaseUrl?: string | null
): ActiveProfileSelector {
  const accounts = global.accounts ?? [];
  const requestedBaseUrl = normalizeBaseUrl(
    explicitBaseUrl ?? process.env.OPENPOND_BASE_URL
  );
  const explicit = normalizeHandle(explicitAccount);
  if (explicit) {
    return requestedBaseUrl
      ? { handle: explicit, baseUrl: requestedBaseUrl }
      : { handle: explicit };
  }

  const envAccount = normalizeHandle(process.env.OPENPOND_ACCOUNT);
  if (envAccount) {
    return requestedBaseUrl
      ? { handle: envAccount, baseUrl: requestedBaseUrl }
      : { handle: envAccount };
  }

  const activeProfile = sanitizeActiveProfile(global.activeProfile);
  if (activeProfile) {
    return requestedBaseUrl
      ? { handle: activeProfile.handle, baseUrl: requestedBaseUrl }
      : activeProfile;
  }

  return accounts[0]
    ? selectorFromAccount(accounts[0])
    : { handle: DEFAULT_ACCOUNT_HANDLE };
}

function ensureAccount(
  accounts: LocalAccountConfig[],
  handle: string,
  baseUrl?: string | null
): LocalAccountConfig {
  const normalizedBaseUrl = normalizeBaseUrl(baseUrl);
  if (normalizedBaseUrl) {
    const idx = findAccountIndex(accounts, handle, normalizedBaseUrl);
    if (idx !== -1) {
      return accounts[idx]!;
    }
  } else {
    const matches = accounts.filter((account) =>
      handleEquals(account.handle, handle)
    );
    if (matches.length > 1) {
      throw new Error(
        `multiple profiles found for ${handle}; pass --base-url to select one`
      );
    }
    if (matches.length === 1) {
      return matches[0]!;
    }
  }
  const next: LocalAccountConfig = { handle };
  if (normalizedBaseUrl) {
    next.baseUrl = normalizedBaseUrl;
  }
  accounts.push(next);
  return next;
}

function cleanupAccount(account: LocalAccountConfig): void {
  if (account.session && Object.keys(account.session).length === 0) {
    delete account.session;
  }
}

function applyScopedKey(
  account: LocalAccountConfig,
  key: (typeof ACCOUNT_SCOPED_KEYS)[number],
  value: unknown,
  options: { undefinedDeletes: boolean }
): void {
  const shouldDelete =
    value === null || (value === undefined && options.undefinedDeletes);
  switch (key) {
    case "apiKey": {
      if (shouldDelete) {
        delete account.apiKey;
        return;
      }
      if (typeof value === "string") {
        account.apiKey = value;
      }
      return;
    }
    case "baseUrl": {
      if (shouldDelete) {
        delete account.baseUrl;
        return;
      }
      if (typeof value === "string") {
        account.baseUrl = value;
      }
      return;
    }
    case "apiBaseUrl": {
      if (shouldDelete) {
        delete account.apiBaseUrl;
        return;
      }
      if (typeof value === "string") {
        account.apiBaseUrl = value;
      }
      return;
    }
    case "chatApiBaseUrl": {
      if (shouldDelete) {
        delete account.chatApiBaseUrl;
        return;
      }
      if (typeof value === "string") {
        account.chatApiBaseUrl = value;
      }
      return;
    }
    case "token":
    case "appId":
    case "conversationId": {
      if (!account.session) account.session = {};
      if (shouldDelete) {
        delete account.session[key];
        cleanupAccount(account);
        return;
      }
      if (typeof value === "string" || value === null) {
        account.session[key] = value;
      }
      cleanupAccount(account);
      return;
    }
  }
}

function applyAccountPatch(
  global: LocalConfig,
  source: LocalConfig,
  options: { undefinedDeletes: boolean }
): boolean {
  const hasScopedPatch = ACCOUNT_SCOPED_KEYS.some((key) => hasOwn(source, key));
  if (!hasScopedPatch) return false;

  const accounts = global.accounts ?? [];
  const selector =
    sanitizeActiveProfile(source.activeProfile) ??
    resolveRequestedProfile(global);
  const requestedBaseUrl = normalizeBaseUrl(
    hasOwn(source, "baseUrl")
      ? source.baseUrl ?? null
      : selector.baseUrl ?? process.env.OPENPOND_BASE_URL
  );
  const account = ensureAccount(accounts, selector.handle, requestedBaseUrl);
  for (const key of ACCOUNT_SCOPED_KEYS) {
    if (!hasOwn(source, key)) continue;
    applyScopedKey(
      account,
      key,
      (source as Record<string, unknown>)[key],
      options
    );
  }
  global.accounts = accounts;
  global.activeProfile = selectorFromAccount(account);
  return true;
}

function applyTopLevelPatch(global: LocalConfig, source: LocalConfig): void {
  if (hasOwn(source, "goalStorageLocation")) {
    if (source.goalStorageLocation === "global" || source.goalStorageLocation === "workspace") {
      global.goalStorageLocation = source.goalStorageLocation;
    } else if (source.goalStorageLocation === null) {
      delete global.goalStorageLocation;
    }
  }
  if (hasOwn(source, "lspEnabled")) {
    if (typeof source.lspEnabled === "boolean") {
      global.lspEnabled = source.lspEnabled;
    } else if (source.lspEnabled === null) {
      delete global.lspEnabled;
    }
  }
  if (hasOwn(source, "executionMode")) {
    if (source.executionMode === "local" || source.executionMode === "hosted") {
      global.executionMode = source.executionMode;
    } else if (source.executionMode === null) {
      delete global.executionMode;
    }
  }
  if (hasOwn(source, "mode")) {
    if (source.mode === "general" || source.mode === "builder") {
      global.mode = source.mode;
    } else if (source.mode === null) {
      delete global.mode;
    }
  }
  if (hasOwn(source, "activeProfile")) {
    const selector = sanitizeActiveProfile(source.activeProfile);
    if (selector) {
      const idx = findAccountIndexForSelector(global.accounts ?? [], selector);
      global.activeProfile =
        idx === -1
          ? selector
          : selectorFromAccount((global.accounts ?? [])[idx]!);
    } else if (source.activeProfile === null) {
      delete global.activeProfile;
    }
  }
  if (hasOwn(source, "openpondProfile")) {
    const profile = sanitizeLocalOpenPondProfile(source.openpondProfile);
    if (profile) {
      global.openpondProfile = profile;
    } else if (source.openpondProfile === null) {
      delete global.openpondProfile;
    }
  }
}

async function writeGlobalConfig(next: LocalConfig): Promise<void> {
  const filePath = getGlobalConfigPath();
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  const payload = JSON.stringify(next, null, 2);
  await fs.writeFile(filePath, payload, "utf-8");
}

export async function loadGlobalConfig(): Promise<LocalConfig> {
  const raw = await loadConfigFile(getGlobalConfigPath());
  return normalizeGlobalConfig(raw);
}

export async function loadConfig(
  options: LoadConfigOptions = {}
): Promise<LocalConfig> {
  const global = await loadGlobalConfig();
  const accounts = global.accounts ?? [];
  const requested = resolveRequestedProfile(
    global,
    options.account,
    options.baseUrl
  );
  const idx = findAccountIndexForSelector(accounts, requested, {
    requireUnambiguous: true,
  });
  const account = idx === -1 ? null : accounts[idx]!;
  const session = account?.session;
  return {
    ...global,
    activeProfile: account ? selectorFromAccount(account) : requested,
    apiKey: account?.apiKey,
    baseUrl: account?.baseUrl,
    apiBaseUrl: account?.apiBaseUrl,
    chatApiBaseUrl: account?.chatApiBaseUrl,
    token: session?.token,
    appId: session?.appId,
    conversationId: session?.conversationId,
  };
}

export async function listConfiguredProfiles(): Promise<ConfiguredProfile[]> {
  const global = await loadGlobalConfig();
  const activeProfile = sanitizeActiveProfile(global.activeProfile);
  return (global.accounts ?? []).map((account) => {
    const handle = normalizeHandle(account.handle) ?? DEFAULT_ACCOUNT_HANDLE;
    return {
      handle,
      baseUrl: normalizeBaseUrl(account.baseUrl),
      apiBaseUrl: normalizeBaseUrl(account.apiBaseUrl),
      chatApiBaseUrl: normalizeBaseUrl(account.chatApiBaseUrl),
      environment: account.environment?.trim() || null,
      isActive: Boolean(
        activeProfile &&
          accountMatchesSelector({ ...account, handle }, activeProfile)
      ),
      hasApiKey: Boolean(account.apiKey?.trim()),
      hasSessionToken: Boolean(account.session?.token?.trim()),
      sessionAppId: account.session?.appId ?? null,
      sessionConversationId: account.session?.conversationId ?? null,
    };
  });
}

export async function setActiveProfile(
  handle: string,
  options: SetActiveProfileOptions = {}
): Promise<ConfiguredProfile> {
  const requestedHandle = requireHandle(handle);
  const requestedBaseUrl = normalizeBaseUrl(options.baseUrl);
  const global = await loadGlobalConfig();
  const accounts = global.accounts ?? [];
  const idx = findAccountIndexForSelector(
    accounts,
    requestedBaseUrl
      ? { handle: requestedHandle, baseUrl: requestedBaseUrl }
      : { handle: requestedHandle },
    { requireUnambiguous: true }
  );
  if (idx === -1) {
    throw new Error(`profile not found: ${requestedHandle}`);
  }

  global.activeProfile = selectorFromAccount(accounts[idx]!);
  await writeGlobalConfig(global);

  const profiles = await listConfiguredProfiles();
  return profiles.find((profile) => profile.isActive) ?? profiles[idx]!;
}

export async function saveProfileApiKey(
  input: SaveProfileApiKeyInput
): Promise<ConfiguredProfile> {
  const handle = requireHandle(input.handle);
  const apiKey = requireApiKey(input.apiKey);
  const baseUrl = normalizeBaseUrl(input.baseUrl);
  const apiBaseUrl = normalizeBaseUrl(input.apiBaseUrl);
  const chatApiBaseUrl = normalizeBaseUrl(input.chatApiBaseUrl);
  const global = await loadGlobalConfig();
  const accounts = global.accounts ?? [];
  const account = ensureAccount(accounts, handle, baseUrl);

  account.apiKey = apiKey;
  if (baseUrl) {
    account.baseUrl = baseUrl;
  }
  if (apiBaseUrl) {
    account.apiBaseUrl = apiBaseUrl;
  } else if (input.apiBaseUrl === null) {
    delete account.apiBaseUrl;
  }
  if (chatApiBaseUrl) {
    account.chatApiBaseUrl = chatApiBaseUrl;
  } else if (input.chatApiBaseUrl === null) {
    delete account.chatApiBaseUrl;
  }
  if (input.environment === null) {
    delete account.environment;
  } else if (
    typeof input.environment === "string" &&
    input.environment.trim()
  ) {
    account.environment = input.environment.trim();
  }

  global.accounts = accounts;
  if (input.setActive !== false) {
    global.activeProfile = selectorFromAccount(account);
  }
  await writeGlobalConfig(global);

  const profiles = await listConfiguredProfiles();
  const saved = profiles.find((profile) => {
    if (!handleEquals(profile.handle, account.handle)) return false;
    if (!baseUrl) return true;
    return normalizeBaseUrl(profile.baseUrl) === baseUrl;
  });
  if (!saved) {
    throw new Error(`failed to save profile: ${handle}`);
  }
  return saved;
}

export async function saveConfig(next: LocalConfig): Promise<void> {
  const global = normalizeGlobalConfig(next);
  applyTopLevelPatch(global, next);
  applyAccountPatch(global, next, { undefinedDeletes: true });
  await writeGlobalConfig(global);
}

export async function saveGlobalConfig(next: LocalConfig): Promise<void> {
  const current = await loadGlobalConfig();
  applyTopLevelPatch(current, next);
  applyAccountPatch(current, next, { undefinedDeletes: false });
  await writeGlobalConfig(current);
}
