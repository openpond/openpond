import { createHash, randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";

import {
  AccountStateSchema,
  BootstrapPayloadSchema,
  CloudWorkItemActivitySchema,
  CloudWorkItemDetailSchema,
  CloudWorkItemMessageSchema,
  CloudWorkItemRuntimeSessionSchema,
  CloudWorkItemSchema,
  CloudWorkItemBackgroundRequestSchema,
  CreatePipelineRequestSchema,
  CreatePipelineSnapshotSchema,
  CreateCloudWorkItemRequestSchema,
  ListCloudWorkItemsRequestSchema,
  OpenCloudWorkItemRequestSchema,
  PatchSidebarAppPreferenceRequestSchema,
  PatchSessionRequestSchema,
  ReorderSidebarAppsRequestSchema,
  SaveOpenPondAccountRequestSchema,
  SendCloudWorkItemMessageRequestSchema,
  SendTurnRequestSchema,
  SessionSchema,
  SwitchOpenPondAccountRequestSchema,
  UpdateAppPreferencesRequestSchema,
  UploadLocalProjectCloudSourceRequestSchema,
  UpdatePersonalizationRequestSchema,
  UpdateProviderSettingsRequestSchema,
  ProviderModelCacheSchema,
  createPlaceholderPanes,
  type AccountState,
  type AppPreferences,
  type BootstrapPayload,
  type CloudProject,
  type CloudProjectSourceType,
  type CloudWorkItem,
  type CloudWorkItemActivity,
  type CloudWorkItemDetail,
  type CloudWorkItemMessage,
  type CloudWorkItemRuntimeSession,
  type CreatePipelineRequest,
  type CreatePipelineSnapshot,
  type CodexStatus,
  type LocalProject,
  type OpenPondApp,
  type ProjectAgentSdk,
  type ProjectAgentSdkDependencyType,
  type RuntimeEvent,
  type ProviderCatalog,
  type ProviderSettings,
  type Session,
  type SidebarAppPreference,
  type SidebarAppPreferences,
} from "@openpond/contracts";
import {
  CodexAppServerClient,
  defaultServerRequestResult,
} from "@openpond/codex-provider";
import {
  loadOpenPondAccountContext,
  loadOpenPondApps,
  saveOpenPondAccount,
  switchOpenPondAccount,
} from "@openpond/runtime";
import {
  collectProfileSourceUploadEntries,
  commitActiveProfileChanges,
  emptyProfileState,
  hostedPublishStatusFromPayload,
  hostedRunStatusFromRunSummary,
  hostedRunSummaryFromPayload,
  hostedSourceCheckStatusFromPayload,
  initLocalProfileRepo,
  loadLocalProfileRepo,
  loadOpenPondProfileState,
  runProfileCheck,
  runProfileSdkCommand,
  saveProfilePushStatus,
  type LocalOpenPondProfilePushStatus,
  type ProfileRepoManifest,
} from "@openpond/cloud";
import { loadGlobalConfig, saveGlobalConfig } from "@openpond/cloud/config";
import {
  chatAttachmentContext,
  formatPromptWithAttachmentContext,
  materializeChatAttachments,
} from "../chat-attachments.js";
import { APP_PREFERENCES_CACHE_KEY, APP_PREFERENCES_CACHE_TYPE } from "../constants.js";
import {
  assertCreatePipelineMutationApproved,
  assertCreatePipelineSnapshotLinked,
} from "../create-pipeline-guards.js";
import { normalizeAppPreferences } from "../preferences.js";
import { loadPersonalizationSettings, savePersonalizationSettings } from "../openpond/personalization.js";
import {
  mergeProviderConfigPatch,
  normalizeProvidersFile,
  readProvidersFile,
  updateProvidersFile,
  writeProvidersFile,
} from "../openpond/provider-settings.js";
import {
  cachedProviderCatalog,
  resolveProviderCatalog,
} from "../openpond/provider-catalog.js";
import {
  buildProviderModelCache,
  buildProviderSettings,
  listProviderModels,
  parseProviderId,
  parseProviderModelsRefreshRequest,
  parseProviderModelsRequest,
  parseProviderValidationRequest,
  providerAllowsLocalCredential,
} from "../openpond/provider-registry.js";
import {
  isOpenAiCompatibleProviderId,
  listOpenAiCompatibleProviderModels,
  validateOpenAiCompatibleProvider,
} from "../openpond/openai-compatible-provider.js";
import { ProviderDiagnosticsTracker } from "../openpond/provider-diagnostics.js";
import {
  deleteProviderCredential,
  parseProviderCredentialDeleteRequest,
  parseProviderCredentialWriteRequest,
  readProviderSecrets,
  updateProviderCredentialValidation,
  writeProviderCredential,
} from "../openpond/provider-secrets.js";
import { providerSecretsConfigPath, providerSecretsKeyPath } from "../paths.js";
import type { SqliteStore } from "../store/store.js";
import type { ProvidersFile } from "../types.js";
import { event, now } from "../utils.js";
import { loadCodexHistorySessions, readCodexHistoryThreadPayload } from "../codex-history.js";
import {
  applyCodexHistorySidebarPreference,
  applyCodexHistorySidebarPreferences,
  loadCodexHistorySidebarPreferences,
  patchCodexHistorySidebarPreference,
} from "../codex-history-sidebar-preferences.js";
import { createOpenPondCache } from "../openpond/server-openpond-cache.js";
import { organizationRequestPayload } from "../openpond/organizations.js";
import { sandboxRequestPayload } from "../openpond/sandboxes.js";
import {
  findLocalProject,
  inferLocalProjectOpenPondLinks,
  listLocalProjects,
  updateLocalProjectAgentSetup,
} from "../workspace/local-projects.js";
import { pushLocalProjectSourceToGit } from "../workspace/local-project-source-upload.js";
import { createServerWorkspacePayloads } from "../workspace/server-workspace-payloads.js";

type OpenPondOrganizationSummary = {
  teamId: string;
  slug: string | null;
  displayName: string | null;
};

export type ServerPayloads = ReturnType<typeof createServerPayloads>;

const CLOUD_PROJECT_SOURCE_TYPES: ReadonlySet<CloudProjectSourceType> = new Set([
  "github_repo",
  "internal_repo",
  "template",
  "manual",
]);
const OPENPOND_AGENT_SDK_PACKAGE_NAME = "openpond-agent-sdk";
const AGENT_SDK_DEPENDENCY_TYPES: ReadonlySet<ProjectAgentSdkDependencyType> = new Set([
  "dependencies",
  "devDependencies",
  "peerDependencies",
  "optionalDependencies",
]);
const AGENT_SDK_DEPENDENCY_FIELDS: ProjectAgentSdkDependencyType[] = [
  "dependencies",
  "devDependencies",
  "peerDependencies",
  "optionalDependencies",
];

type ActiveCodexHistoryTurn = {
  client: CodexAppServerClient;
  completion: Promise<unknown> | null;
  interrupted: boolean;
  ready: Promise<void>;
  resolveReady: () => void;
  threadId: string;
  turnId: string | null;
};
const CLOUD_PROJECT_CACHE_TYPE = "openpond.cloudProjects";
const BOOTSTRAP_EVENT_WINDOW_LIMIT = 500;
const BOOTSTRAP_DIAGNOSTIC_LIMIT = 50;
const BOOTSTRAP_CODEX_HISTORY_LIMIT = 50;

function hasObjectKey(value: unknown, key: string): boolean {
  return Boolean(value && typeof value === "object" && Object.prototype.hasOwnProperty.call(value, key));
}

export function assertCreatePipelineBackgroundApproved(input: {
  request?: CreatePipelineRequest | null;
  snapshot?: CreatePipelineSnapshot | null;
}): void {
  assertCreatePipelineMutationApproved({
    actionLabel: "Create pipeline background work",
    request: input.request,
    snapshot: input.snapshot,
  });
}

async function fetchCloudProjects(): Promise<CloudProject[]> {
  try {
    const organizationPayload = asRecord(await organizationRequestPayload({ type: "list" }));
    const organizationRows = asRecordArray(organizationPayload.organizations);
    const organizations = (organizationRows.length > 0 ? organizationRows : asRecordArray(organizationPayload.teams))
      .map(normalizeOpenPondOrganization)
      .filter((organization): organization is OpenPondOrganizationSummary => Boolean(organization?.teamId));
    const projectLists = await Promise.all(
      organizations.map(async (organization) => {
        try {
          const payload = asRecord(
            await sandboxRequestPayload({
              type: "project_list",
              payload: { teamId: organization.teamId },
            }),
          );
          return asRecordArray(payload.projects)
            .map((project) => normalizeCloudProject(project, organization))
            .filter((project): project is CloudProject => Boolean(project));
        } catch {
          return [];
        }
      }),
    );
    const byKey = new Map<string, CloudProject>();
    for (const project of projectLists.flat()) {
      byKey.set(`${project.teamId}:${project.id}`, project);
    }
    return Array.from(byKey.values()).sort((left, right) => {
      const leftUpdated = Date.parse(left.updatedAt ?? "") || 0;
      const rightUpdated = Date.parse(right.updatedAt ?? "") || 0;
      if (leftUpdated !== rightUpdated) return rightUpdated - leftUpdated;
      return left.name.localeCompare(right.name);
    });
  } catch {
    return [];
  }
}

function normalizeOpenPondOrganization(value: Record<string, unknown>): OpenPondOrganizationSummary | null {
  const teamId = stringValue(value.teamId) ?? stringValue(value.id);
  if (!teamId) return null;
  return {
    teamId,
    slug: stringValue(value.slug),
    displayName: stringValue(value.displayName) ?? stringValue(value.name),
  };
}

function normalizeCloudProject(
  value: Record<string, unknown>,
  organization: OpenPondOrganizationSummary,
): CloudProject | null {
  const id = stringValue(value.id);
  const teamId = stringValue(value.teamId) ?? organization.teamId;
  if (!id || !teamId) return null;
  const status = stringValue(value.status);
  if (status === "archived" || stringValue(value.archivedAt)) return null;
  const name = stringValue(value.name) ?? stringValue(value.slug) ?? id;
  const sourceType = normalizeCloudProjectSourceType(value.sourceType);
  return {
    id,
    teamId,
    name,
    slug: stringValue(value.slug),
    sourceType,
    sourceLabel: cloudProjectSourceLabel(value, sourceType),
    defaultBranch: stringValue(value.defaultBranch) ?? stringValue(value.gitBranch),
    internalRepoPath: stringValue(value.internalRepoPath),
    manifestPath: stringValue(value.sandboxManifestPath),
    manifestHash: stringValue(value.sandboxManifestHash),
    syncedAt: stringValue(value.sandboxManifestSyncedAt),
    agentSdk: cloudProjectAgentSdk(value),
    organizationName: organization.displayName,
    organizationSlug: organization.slug,
    createdAt: stringValue(value.createdAt),
    updatedAt: stringValue(value.updatedAt),
  };
}

function normalizeCloudProjectSourceType(value: unknown): CloudProjectSourceType {
  return typeof value === "string" && CLOUD_PROJECT_SOURCE_TYPES.has(value as CloudProjectSourceType)
    ? (value as CloudProjectSourceType)
    : "manual";
}

function cloudProjectSourceLabel(
  value: Record<string, unknown>,
  sourceType: CloudProjectSourceType,
): string | null {
  if (sourceType === "github_repo") {
    const owner = stringValue(value.gitOwner);
    const repo = stringValue(value.gitRepo);
    if (owner && repo) return `${owner}/${repo}`;
  }
  if (sourceType === "internal_repo") {
    return stringValue(value.internalRepoPath) ?? "Internal repo";
  }
  if (sourceType === "template") {
    return stringValue(value.templateRepoUrl) ?? stringValue(value.templateSourceProjectId) ?? "Template";
  }
  return stringValue(value.normalizedSourceIdentity);
}

function cloudProjectAgentSdk(value: Record<string, unknown>): ProjectAgentSdk | null {
  const metadata = asRecord(value.metadata);
  const sourceConfig = asRecord(value.sourceConfig);
  return (
    normalizeProjectAgentSdk(value.agentSdk) ??
    normalizeProjectAgentSdk(value.openpondAgentSdk) ??
    normalizeProjectAgentSdk(metadata.agentSdk) ??
    normalizeProjectAgentSdk(metadata.openpondAgentSdk) ??
    normalizeProjectAgentSdk(sourceConfig.agentSdk) ??
    normalizeProjectAgentSdk(sourceConfig.openpondAgentSdk) ??
    projectAgentSdkFromBooleanFlags(value, metadata, sourceConfig) ??
    projectAgentSdkFromPackageManifest(value.packageJson) ??
    projectAgentSdkFromPackageManifest(metadata.packageJson) ??
    projectAgentSdkFromPackageManifest(sourceConfig.packageJson)
  );
}

function normalizeProjectAgentSdk(value: unknown): ProjectAgentSdk | null {
  if (value === true) return detectedProjectAgentSdk({});
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  const manifestDetection = projectAgentSdkFromPackageManifest(record.packageJson);
  if (manifestDetection) return manifestDetection;
  const detected =
    booleanValue(record.detected) ??
    booleanValue(record.usesOpenPondAgentSdk) ??
    booleanValue(record.openpondAgentSdkDetected);
  if (detected === false) {
    return {
      detected: false,
      packageName: OPENPOND_AGENT_SDK_PACKAGE_NAME,
      rootPath: null,
      manifestPath: stringValue(record.manifestPath) ?? stringValue(record.packageJsonPath),
      version: null,
      dependencyType: null,
    };
  }
  const packageName =
    stringValue(record.packageName) ??
    stringValue(record.name) ??
    OPENPOND_AGENT_SDK_PACKAGE_NAME;
  const version =
    stringValue(record.version) ??
    stringValue(record.versionRange) ??
    stringValue(record.packageVersion);
  if (detected !== true && packageName !== OPENPOND_AGENT_SDK_PACKAGE_NAME && !version) return null;
  return detectedProjectAgentSdk({
    packageName,
    rootPath: stringValue(record.rootPath),
    manifestPath:
      stringValue(record.manifestPath) ??
      stringValue(record.packageJsonPath) ??
      stringValue(record.path),
    version,
    dependencyType:
      dependencyTypeValue(record.dependencyType) ??
      dependencyTypeValue(record.dependencyField),
  });
}

function projectAgentSdkFromBooleanFlags(
  value: Record<string, unknown>,
  metadata: Record<string, unknown>,
  sourceConfig: Record<string, unknown>,
): ProjectAgentSdk | null {
  if (
    booleanValue(value.usesOpenPondAgentSdk) ||
    booleanValue(value.openpondAgentSdkDetected) ||
    booleanValue(metadata.usesOpenPondAgentSdk) ||
    booleanValue(metadata.openpondAgentSdkDetected) ||
    booleanValue(sourceConfig.usesOpenPondAgentSdk) ||
    booleanValue(sourceConfig.openpondAgentSdkDetected)
  ) {
    return detectedProjectAgentSdk({});
  }
  return null;
}

function projectAgentSdkFromPackageManifest(value: unknown): ProjectAgentSdk | null {
  const manifest = asRecord(value);
  if (Object.keys(manifest).length === 0) return null;
  for (const dependencyType of AGENT_SDK_DEPENDENCY_FIELDS) {
    const dependencies = asRecord(manifest[dependencyType]);
    const version = stringValue(dependencies[OPENPOND_AGENT_SDK_PACKAGE_NAME]);
    if (!version) continue;
    return detectedProjectAgentSdk({
      manifestPath: stringValue(manifest.path) ?? stringValue(manifest.manifestPath),
      version,
      dependencyType,
    });
  }
  return null;
}

function detectedProjectAgentSdk(input: {
  packageName?: string | null;
  rootPath?: string | null;
  manifestPath?: string | null;
  version?: string | null;
  dependencyType?: ProjectAgentSdkDependencyType | null;
}): ProjectAgentSdk {
  return {
    detected: true,
    packageName: input.packageName ?? OPENPOND_AGENT_SDK_PACKAGE_NAME,
    rootPath: input.rootPath ?? null,
    manifestPath: input.manifestPath ?? null,
    version: input.version ?? null,
    dependencyType: input.dependencyType ?? null,
  };
}

function dependencyTypeValue(value: unknown): ProjectAgentSdkDependencyType | null {
  return typeof value === "string" && AGENT_SDK_DEPENDENCY_TYPES.has(value as ProjectAgentSdkDependencyType)
    ? (value as ProjectAgentSdkDependencyType)
    : null;
}

function booleanValue(value: unknown): boolean | null {
  return typeof value === "boolean" ? value : null;
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

function nonEmptyRecord(value: unknown): Record<string, unknown> | null {
  const record = asRecord(value);
  return Object.keys(record).length > 0 ? record : null;
}

function asRecordArray(value: unknown): Array<Record<string, unknown>> {
  return Array.isArray(value) ? value.map(asRecord).filter((item) => Object.keys(item).length > 0) : [];
}

function stringValue(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function parseHostedSourceDispatch(value: string | null): "request_only" | "coding_core" | null {
  if (!value) return null;
  if (value === "request_only" || value === "coding_core") return value;
  throw new Error("hostedSourceDispatch must be one of request_only, coding_core.");
}

function buildProfileHostedRunIdempotencyKey(input: {
  input: Record<string, unknown>;
  localHead: string;
  hostedHead?: string | null;
  hostedRunAgentId: string;
  hostedRunInput: Record<string, unknown>;
}): string {
  const explicit = stringValue(input.input.hostedRunIdempotencyKey);
  if (explicit) return explicit;
  const sourceHead = input.hostedHead || "unknown-source";
  const inputHash = hashStableJson(input.hostedRunInput).slice(0, 16);
  const base = `profile-push-run:${input.localHead}:${sourceHead}:${input.hostedRunAgentId}:${inputHash}`;
  return booleanValue(input.input.hostedRunRetry)
    ? `${base}:retry:${randomUUID()}`
    : base;
}

function hashStableJson(value: unknown): string {
  return createHash("sha256").update(stableJsonStringify(value)).digest("hex");
}

function stableJsonStringify(value: unknown): string {
  if (value === undefined) return "undefined";
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) {
    return `[${value.map((item) => stableJsonStringify(item)).join(",")}]`;
  }
  return `{${Object.entries(value as Record<string, unknown>)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, item]) => `${JSON.stringify(key)}:${stableJsonStringify(item)}`)
    .join(",")}}`;
}

function stringArrayValue(value: unknown): string[] {
  return Array.isArray(value)
    ? value
        .filter((item): item is string => typeof item === "string" && item.trim().length > 0)
        .map((item) => item.trim())
    : [];
}

function profileActionRunSummary(input: {
  action: string;
  code: number | null;
  stdout: string;
  stderr: string;
}): {
  artifactRefs: string[];
  output: string;
  responseSummary: Record<string, unknown>;
  status: "completed" | "failed";
  traceArtifactRefs: string[];
} {
  const status = input.code === 0 || input.code === null ? "completed" : "failed";
  let output = input.stdout.trim() || input.stderr.trim() || `Ran profile action ${input.action}.`;
  let artifactRefs: string[] = [];
  let traceArtifactRefs: string[] = [];
  try {
    const parsed = JSON.parse(input.stdout) as unknown;
    const parsedRecord = asRecord(parsed);
    const result = asRecord(parsedRecord.result);
    const resultText =
      stringValue(result.text) ??
      stringValue(result.summary) ??
      stringValue(result.message);
    if (resultText) output = resultText;
    artifactRefs = stringArrayValue(result.artifactRefs);
    const traceArtifactRef = stringValue(parsedRecord.traceArtifactRef);
    traceArtifactRefs = traceArtifactRef ? [traceArtifactRef] : [];
  } catch {
    // Plain stdout/stderr from an SDK command is still useful as the action response.
  }
  return {
    artifactRefs,
    output,
    responseSummary: {
      status: status === "completed" ? "available" : "failed",
      text: output,
    },
    status,
    traceArtifactRefs,
  };
}

export function createServerPayloads(deps: {
  attachmentRootDir?: string;
  store: SqliteStore;
  storeDir: string;
  providersFilePath: string;
  serverId: string;
  host: string;
  getActualPort: () => number;
  startedAt: string;
  version: string;
  runtimeVersion: string;
  getCodexStatus: () => CodexStatus;
  appendRuntimeEvent: (runtimeEvent: RuntimeEvent) => Promise<void>;
  isClosing: () => boolean;
}) {
  const {
    store,
    storeDir,
    providersFilePath,
    serverId,
    host,
    getActualPort,
    startedAt,
    version,
    runtimeVersion,
    getCodexStatus,
    appendRuntimeEvent,
    isClosing,
  } = deps;
  const attachmentRootDir = deps.attachmentRootDir ?? path.join(storeDir, "attachments");
  const {
    appendAppPage,
    loadOpenPondData,
    mergeScaffoldApps,
    metaFromCache,
    openPondCacheScope,
    upsertScaffoldApp,
    waitForOpenPondRefresh,
  } = createOpenPondCache({ store, appendRuntimeEvent, isClosing });
  const cloudProjectRefreshes = new Map<string, Promise<CloudProject[]>>();
  const providerSecretPaths = {
    secretsFilePath: providerSecretsConfigPath(storeDir),
    keyFilePath: providerSecretsKeyPath(storeDir),
  };
  const providerDiagnostics = new ProviderDiagnosticsTracker();
  const activeCodexHistoryTurns = new Map<string, ActiveCodexHistoryTurn>();

  async function loadAppPreferences(): Promise<AppPreferences> {
    const entry = await store.getCacheEntry<unknown>(APP_PREFERENCES_CACHE_TYPE, APP_PREFERENCES_CACHE_KEY);
    const preferences = normalizeAppPreferences(entry?.payload);
    if (hasObjectKey(entry?.payload, "goalStorageLocation")) return preferences;
    const global = await loadGlobalConfig().catch(() => null);
    return normalizeAppPreferences({
      ...preferences,
      ...(global?.goalStorageLocation ? { goalStorageLocation: global.goalStorageLocation } : {}),
    });
  }

  async function loadProvidersFile(): Promise<ProvidersFile> {
    return readProvidersFile(providersFilePath);
  }

  async function loadProvidersFileWithCatalog(options: {
    refresh: boolean;
  }): Promise<{
    file: ProvidersFile;
    catalog: ProviderCatalog | null;
  }> {
    const file = await loadProvidersFile();
    if (!options.refresh) {
      return { file, catalog: cachedProviderCatalog(file) };
    }
    const resolved = await resolveProviderCatalog({
      file,
      timestamp: now(),
    });
    if (resolved.source === "hosted" && resolved.file !== file) {
      await updateProvidersFile(providersFilePath, () => resolved.file);
    }
    return { file: resolved.file, catalog: resolved.catalog };
  }

  async function loadProviderSettings(input: {
    account?: AccountState | null;
    codex?: CodexStatus | null;
    refreshCatalog?: boolean;
  } = {}): Promise<ProviderSettings> {
    const [providerState, secrets] = await Promise.all([
      loadProvidersFileWithCatalog({ refresh: input.refreshCatalog ?? true }),
      readProviderSecrets(providerSecretPaths),
    ]);
    return buildProviderSettings({
      file: providerState.file,
      secrets,
      account: input.account,
      codex: input.codex ?? getCodexStatus(),
      catalog: providerState.catalog,
    });
  }

  async function updateAppPreferencesPayload(payload: unknown): Promise<BootstrapPayload> {
    const input = UpdateAppPreferencesRequestSchema.parse(payload);
    const current = await loadAppPreferences();
    const next = normalizeAppPreferences({ ...current, ...input });
    await store.setCacheEntry(APP_PREFERENCES_CACHE_TYPE, APP_PREFERENCES_CACHE_KEY, next);
    if (hasObjectKey(payload, "goalStorageLocation")) {
      await saveGlobalConfig({ goalStorageLocation: next.goalStorageLocation });
    }
    return bootstrapPayload();
  }

  async function updateProviderSettingsPayload(payload: unknown): Promise<ProviderSettings> {
    const input = UpdateProviderSettingsRequestSchema.parse(payload);
    await updateProvidersFile(providersFilePath, (current) => {
      let next = current;
      for (const [providerId, patch] of Object.entries(input.providers ?? {})) {
        parseProviderId(providerId);
        next = mergeProviderConfigPatch({
          value: next,
          providerId,
          patch,
          updatedAt: now(),
        });
      }
      return next;
    });
    return providerSettingsPayload();
  }

  async function providerSettingsPayload(): Promise<ProviderSettings> {
    return providerDiagnostics.track("provider_settings", null, async () => {
      const [openPond, providerState, secrets] = await Promise.all([
        loadOpenPondData({ force: false }),
        loadProvidersFileWithCatalog({ refresh: true }),
        readProviderSecrets(providerSecretPaths),
      ]);
      return buildProviderSettings({
        file: providerState.file,
        secrets,
        account: openPond.account,
        codex: getCodexStatus(),
        catalog: providerState.catalog,
      });
    });
  }

  async function localProviderRuntimeState(): Promise<{
    file: ProvidersFile;
    secrets: Awaited<ReturnType<typeof readProviderSecrets>>;
    catalog: ProviderCatalog | null;
    settings: ProviderSettings;
  }> {
    const [file, secrets] = await Promise.all([
      loadProvidersFile(),
      readProviderSecrets(providerSecretPaths),
    ]);
    const catalog = cachedProviderCatalog(file);
    return {
      file,
      secrets,
      catalog,
      settings: buildProviderSettings({
        file,
        secrets,
        codex: getCodexStatus(),
        catalog,
      }),
    };
  }

  async function listProviderModelsPayload(providerIdValue: string, payload: unknown): Promise<unknown> {
    const providerId = parseProviderId(providerIdValue);
    const request = parseProviderModelsRequest(payload);
    if (request.refresh) {
      return refreshProviderModelsPayload(providerId, { query: request.query, force: true });
    }
    const providers = await providerSettingsPayload();
    return {
      ...listProviderModels(providers, providerId, request),
      providers,
    };
  }

  async function refreshProviderModelsPayload(providerIdValue: string, payload: unknown): Promise<unknown> {
    const providerId = parseProviderId(providerIdValue);
    return providerDiagnostics.track("model_discovery", providerId, async () => {
      const request = parseProviderModelsRefreshRequest(payload);
      const state = await localProviderRuntimeState();
      let cache = buildProviderModelCache({
        providerId,
        file: state.file,
        fetchedAt: now(),
        catalog: state.catalog,
      });
      if (isOpenAiCompatibleProviderId(providerId)) {
        try {
          const models = await listOpenAiCompatibleProviderModels({
            providerId,
            settings: state.settings,
            secrets: state.secrets,
          });
          cache = ProviderModelCacheSchema.parse({
            providerId,
            models,
            fetchedAt: now(),
            lastError: null,
            source: "provider",
          });
        } catch (error) {
          cache = ProviderModelCacheSchema.parse({
            ...cache,
            fetchedAt: now(),
            lastError: error instanceof Error ? error.message : String(error),
          });
        }
      }
      await updateProvidersFile(providersFilePath, (current) =>
        normalizeProvidersFile({
          ...current,
          modelCaches: {
            ...(current.modelCaches ?? {}),
            [providerId]: cache,
          },
        }),
      );
      const providers = await providerSettingsPayload();
      return {
        ...listProviderModels(providers, providerId, {
          query: request.query,
          refresh: false,
          limit: 100,
        }),
        providers,
      };
    });
  }

  async function writeProviderCredentialPayload(
    providerIdValue: string,
    payload: unknown,
  ): Promise<ProviderSettings> {
    const providerId = parseProviderId(providerIdValue);
    const current = await loadProvidersFile();
    const catalog = cachedProviderCatalog(current);
    if (!providerAllowsLocalCredential(providerId, catalog)) {
      throw new Error(`Provider ${providerId} does not accept local credentials.`);
    }
    await writeProviderCredential({
      paths: providerSecretPaths,
      providerId,
      request: parseProviderCredentialWriteRequest(payload),
      timestamp: now(),
    });
    await updateProvidersFile(providersFilePath, (latest) =>
      mergeProviderConfigPatch({
        value: latest,
        providerId,
        patch: { enabled: true },
        updatedAt: now(),
      }),
    );
    return providerSettingsPayload();
  }

  async function deleteProviderCredentialPayload(
    providerIdValue: string,
    payload: unknown,
  ): Promise<ProviderSettings> {
    const providerId = parseProviderId(providerIdValue);
    const current = await loadProvidersFile();
    if (!providerAllowsLocalCredential(providerId, cachedProviderCatalog(current))) {
      throw new Error(`Provider ${providerId} does not use local credentials.`);
    }
    await deleteProviderCredential({
      paths: providerSecretPaths,
      providerId,
      request: parseProviderCredentialDeleteRequest(payload),
    });
    return providerSettingsPayload();
  }

  async function validateProviderCredentialPayload(
    providerIdValue: string,
    payload: unknown,
  ): Promise<unknown> {
    const providerId = parseProviderId(providerIdValue);
    return providerDiagnostics.track("provider_validation", providerId, async () => {
      const request = parseProviderValidationRequest(payload);
      const state = await localProviderRuntimeState();
      const status = state.settings.statuses[providerId];
      const config = state.settings.providers[providerId];
      if (!status || !config) throw new Error(`Unknown provider: ${providerId}`);

      if (isOpenAiCompatibleProviderId(providerId)) {
        try {
          const validation = await validateOpenAiCompatibleProvider({
            providerId,
            settings: state.settings,
            secrets: state.secrets,
            baseUrl: request.baseUrl,
            modelId: request.modelId,
          });
          await updateProviderCredentialValidation({
            paths: providerSecretPaths,
            providerId,
            timestamp: now(),
            lastError: validation.ok ? null : validation.errors.join("; "),
          });
          const providers = await providerSettingsPayload();
          return {
            ...validation,
            credential: providers.statuses[providerId]?.credential ?? status.credential,
            providers,
          };
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          await updateProviderCredentialValidation({
            paths: providerSecretPaths,
            providerId,
            timestamp: now(),
            lastError: message,
          });
          const providers = await providerSettingsPayload();
          return {
            providerId,
            ok: false,
            live: true,
            baseUrl: request.baseUrl ?? config.baseUrl,
            modelId: request.modelId ?? config.defaultModel ?? null,
            credential: providers.statuses[providerId]?.credential ?? status.credential,
            errors: [message],
            providers,
          };
        }
      }

      const baseUrl = request.baseUrl ?? config.baseUrl;
      const modelId = request.modelId ?? config.defaultModel ?? state.settings.modelCaches[providerId]?.models[0]?.id ?? null;
      const errors: string[] = [];
      if (!status.credential.connected) {
        errors.push(status.credential.lastError ?? `Provider ${providerId} has no connected credential.`);
      }
      if (!modelId) {
        errors.push(`Provider ${providerId} has no selected or cached model.`);
      }

      const providers = await providerSettingsPayload();
      return {
        providerId,
        ok: errors.length === 0,
        live: false,
        baseUrl,
        modelId,
        credential: providers.statuses[providerId]?.credential ?? status.credential,
        errors,
        providers,
      };
    });
  }

  function providerSettingsBootstrapSummary(settings: ProviderSettings): ProviderSettings {
    const modelCaches: ProviderSettings["modelCaches"] = {};
    for (const [providerId, cache] of Object.entries(settings.modelCaches)) {
      modelCaches[providerId] = {
        ...cache,
        models: [],
      };
    }
    return {
      ...settings,
      modelCaches,
    };
  }

  async function providerDiagnosticsPayload(): Promise<unknown> {
    const state = await localProviderRuntimeState();
    return providerDiagnostics.snapshot(state.settings);
  }

  async function updatePersonalizationPayload(payload: unknown): Promise<BootstrapPayload> {
    const input = UpdatePersonalizationRequestSchema.parse(payload);
    await savePersonalizationSettings(store, storeDir, input);
    return bootstrapPayload();
  }

  async function loadBootstrapProfile(ensureProfile: boolean) {
    const profile = await loadOpenPondProfileState();
    if (!ensureProfile || profile.mode !== "none") return profile;
    try {
      return await initLocalProfileRepo();
    } catch (error) {
      return {
        ...emptyProfileState(),
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }

  async function refreshCloudProjects(scope: string): Promise<CloudProject[]> {
    const existing = cloudProjectRefreshes.get(scope);
    if (existing) return existing;
    const refresh = (async () => {
      const projects = await fetchCloudProjects();
      const entry = await store.setCacheEntry(CLOUD_PROJECT_CACHE_TYPE, scope, projects, null);
      return entry.payload;
    })().catch(async (error) => {
      await store.setCacheError(
        CLOUD_PROJECT_CACHE_TYPE,
        scope,
        [],
        error instanceof Error ? error.message : String(error),
      );
      throw error;
    }).finally(() => {
      if (cloudProjectRefreshes.get(scope) === refresh) cloudProjectRefreshes.delete(scope);
    });
    cloudProjectRefreshes.set(scope, refresh);
    return refresh;
  }

  function refreshCloudProjectsInBackground(scope: string): void {
    if (cloudProjectRefreshes.has(scope) || isClosing()) return;
    void refreshCloudProjects(scope).catch((error) => {
      if (isClosing()) return;
      void appendRuntimeEvent(
        event({
          name: "diagnostic",
          source: "server",
          status: "failed",
          output: error instanceof Error ? error.message : String(error),
        }),
      );
    });
  }

  async function loadCloudProjectsForBootstrap(
    account: AccountState,
    options: { force?: boolean } = {},
  ): Promise<CloudProject[]> {
    if (account.state !== "signed_in") return [];
    const scope = openPondCacheScope(account);
    if (options.force) return refreshCloudProjects(scope);
    const cached = await store.getCacheEntry<CloudProject[]>(CLOUD_PROJECT_CACHE_TYPE, scope);
    if (!cached) refreshCloudProjectsInBackground(scope);
    return cached?.payload ?? [];
  }

  async function bootstrapPayload(
    bootstrapOptions: { forceOpenPond?: boolean; ensureProfile?: boolean } = {},
  ): Promise<BootstrapPayload> {
    const [
      sessionShells,
      eventWindow,
      diagnostics,
      pendingApprovals,
      openPond,
      preferences,
      personalization,
      localProjects,
      profile,
    ] = await Promise.all([
      store.sessionShells(),
      store.recentRuntimeEventWindow(BOOTSTRAP_EVENT_WINDOW_LIMIT),
      store.recentDiagnostics(BOOTSTRAP_DIAGNOSTIC_LIMIT),
      store.pendingApprovals(),
      loadOpenPondData({ force: bootstrapOptions.forceOpenPond }),
      loadAppPreferences(),
      loadPersonalizationSettings(store, storeDir),
      listLocalProjects(store),
      loadBootstrapProfile(Boolean(bootstrapOptions.ensureProfile)),
    ]);
    const codex = getCodexStatus();
    const providers = providerSettingsBootstrapSummary(await loadProviderSettings({
      account: openPond.account,
      codex,
      refreshCatalog: false,
    }));
    const cloudProjects = await loadCloudProjectsForBootstrap(openPond.account, {
      force: bootstrapOptions.forceOpenPond,
    });
    const openPondCodexThreadIds = new Set(
      sessionShells
        .map((session) => session.codexThreadId)
        .filter((threadId): threadId is string => Boolean(threadId)),
    );
    const [codexHistorySessions, codexHistorySidebarPreferences] = await Promise.all([
      loadCodexHistorySessions({
        excludeThreadIds: openPondCodexThreadIds,
        metadataLimit: BOOTSTRAP_CODEX_HISTORY_LIMIT,
      }).catch(() => []),
      loadCodexHistorySidebarPreferences(store),
    ]);
    const linkedLocalProjects = await inferLocalProjectOpenPondLinks(localProjects, openPond.apps);
    const scope = openPondCacheScope(openPond.account);
    const sidebarAppPreferences = await store.getSidebarAppPreferences(scope);
    const payload: BootstrapPayload = {
      server: {
        id: serverId,
        host,
        port: getActualPort(),
        startedAt,
        storePath: store.storePath,
        version: version,
        runtimeVersion: runtimeVersion,
      },
      account: openPond.account,
      codex,
      preferences,
      providers,
      personalization,
      apps: openPond.apps,
      localProjects: linkedLocalProjects,
      cloudProjects,
      profile,
      codexHistorySessions: validBootstrapSessions(
        applyCodexHistorySidebarPreferences(codexHistorySessions, codexHistorySidebarPreferences),
      ),
      sidebarAppPreferences,
      appsError: openPond.appsError,
      appsMeta: openPond.appsMeta,
      accountMeta: openPond.accountMeta,
      sessions: validBootstrapSessions(sessionShells),
      events: eventWindow.entries.map((entry) => entry.event),
      eventWindow: {
        latestSequence: eventWindow.latestSequence,
        oldestSequence: eventWindow.oldestSequence,
        totalEvents: eventWindow.totalEvents,
        limit: eventWindow.limit,
        hasMoreBefore: eventWindow.hasMoreBefore,
      },
      approvals: pendingApprovals,
      placeholders: createPlaceholderPanes(),
      diagnostics,
    };
    return BootstrapPayloadSchema.parse(payload);
  }

  async function codexHistoryThreadPayload(sessionId: string, requestUrl?: URL): Promise<unknown> {
    const [payload, preferences] = await Promise.all([
      readCodexHistoryThreadPayload(sessionId, {
        ...codexHistoryThreadReadOptions(requestUrl),
        attachmentRootDir,
      }),
      loadCodexHistorySidebarPreferences(store),
    ]);
    return {
      ...payload,
      session: applyCodexHistorySidebarPreference(payload.session, preferences),
    };
  }

  async function patchCodexHistorySessionPayload(sessionId: string, payload: unknown): Promise<unknown> {
    PatchSessionRequestSchema.parse(payload);
    const current = await readCodexHistoryThreadPayload(sessionId, { attachmentRootDir });
    await patchCodexHistorySidebarPreference(store, sessionId, payload);
    return applyCodexHistorySidebarPreference(current.session, await loadCodexHistorySidebarPreferences(store));
  }

  async function sendCodexHistoryTurnPayload(sessionId: string, payload: unknown): Promise<unknown> {
    const input = SendTurnRequestSchema.parse(payload);
    if (activeCodexHistoryTurns.has(sessionId)) {
      throw new Error("A Codex history turn is already running for this chat.");
    }
    const current = await readCodexHistoryThreadPayload(sessionId, { attachmentRootDir });
    const threadId = current.session.codexThreadId;
    if (!threadId) throw new Error("Codex history session is missing its Codex thread id");
    const cwd = input.cwd ?? current.session.cwd;
    const turnId = nextCodexHistoryTurnId(current.events, current.session.id);
    const attachmentContexts = await materializeChatAttachments({
      attachmentRootDir,
      sessionId: current.session.id,
      turnId,
      attachments: input.attachments,
    });
    const providerPrompt = formatPromptWithAttachmentContext(input.prompt, chatAttachmentContext(attachmentContexts));
    const client = new CodexAppServerClient({
      binaryPath: process.env.CODEX_BINARY || "codex",
      clientName: "openpond-app",
      clientTitle: "OpenPond App",
      clientVersion: version,
      onNotification: () => undefined,
      onServerRequest: async (request) => defaultServerRequestResult(request),
    });
    let resolveReady: () => void = () => undefined;
    const ready = new Promise<void>((resolve) => {
      resolveReady = resolve;
    });
    const activeTurn: ActiveCodexHistoryTurn = {
      client,
      completion: null,
      interrupted: false,
      ready,
      resolveReady,
      threadId,
      turnId: null,
    };
    activeCodexHistoryTurns.set(sessionId, activeTurn);
    try {
      await client.resumeThread({
        threadId,
        cwd,
        approvalPolicy: input.approvalPolicy,
        sandbox: input.sandbox,
        config: codexHistorySessionConfig(input.codexPermissionMode),
      });
      const turn = await client.startTurn({
        threadId,
        prompt: providerPrompt,
        cwd,
        model: input.model,
        approvalPolicy: input.approvalPolicy,
        sandbox: input.sandbox,
      });
      const completion = client.waitForTurn(turn.turnId);
      activeTurn.completion = completion;
      activeTurn.turnId = turn.turnId;
      activeTurn.resolveReady();
      try {
        await completion;
      } catch (error) {
        if (!activeTurn.interrupted) throw error;
      }
      return codexHistoryThreadPayload(sessionId);
    } finally {
      activeTurn.resolveReady();
      if (activeTurn && activeCodexHistoryTurns.get(sessionId) === activeTurn) {
        activeCodexHistoryTurns.delete(sessionId);
      }
      await client.stop().catch(() => undefined);
    }
  }

  async function interruptCodexHistoryTurnPayload(sessionId: string): Promise<unknown> {
    const activeTurn = activeCodexHistoryTurns.get(sessionId);
    if (!activeTurn) return { interrupted: false };
    activeTurn.interrupted = true;
    await activeTurn.ready;
    if (!activeTurn.turnId || !activeTurn.completion) return { interrupted: false };
    await activeTurn.client.interruptTurn({
      threadId: activeTurn.threadId,
      turnId: activeTurn.turnId,
    });
    await activeTurn.completion.catch(() => undefined);
    return { interrupted: true };
  }

  function validBootstrapSessions(sessions: Session[]): Session[] {
    return sessions.filter((session) => SessionSchema.safeParse(session).success);
  }

  async function findOpenPondApp(appId: string): Promise<OpenPondApp> {
    let data = await loadOpenPondData();
    let app = data.apps.find((candidate) => candidate.id === appId);
    if (!app) {
      data = await loadOpenPondData({ force: true });
      app = data.apps.find((candidate) => candidate.id === appId);
    }
    if (!app) throw new Error("OpenPond app not found");
    return app;
  }

  const workspacePayloads = createServerWorkspacePayloads({
    store,
    storeDir,
    openPondCacheScope,
    findOpenPondApp,
    loadAppPreferences,
    bootstrapPayload,
  });

  async function uploadLocalProjectCloudSourcePayload(
    projectId: string,
    payload: unknown,
  ): Promise<{
    project: CloudProject;
    localProject: LocalProject;
    bootstrap: BootstrapPayload;
    upload: {
      rootPath: string;
      branch: string;
      fileCount: number;
      byteCount: number;
      skippedCount: number;
      initializedEmptyProject: boolean;
    };
  }> {
    const input = UploadLocalProjectCloudSourceRequestSchema.parse(payload);
    const localProject = await findLocalProject(store, projectId);
    if (!localProject) throw new Error("Project workspace not found");

    const linkedProject =
      localProject.linkedSandboxProject?.teamId === input.teamId
        ? localProject.linkedSandboxProject
        : null;
    const branch =
      input.branch?.trim() ||
      linkedProject?.defaultBranch?.trim() ||
      "main";
    const projectName =
      input.projectName?.trim() ||
      linkedProject?.projectName?.trim() ||
      localProject.name;
    const internalRepoPath =
      linkedProject?.sourceRepoUrl?.trim() || internalRepoPathForLocalProject(localProject);
    const fallbackReadme = `# ${projectName}\n\nUploaded from OpenPond Desktop.\n`;
    const initialProjectRecord = linkedProject?.projectId
      ? await sandboxProjectRecordOrFallback({
          projectId: linkedProject.projectId,
          teamId: input.teamId,
          fallback: {
            id: linkedProject.projectId,
            teamId: input.teamId,
            name: projectName,
            slug: linkedProject.projectSlug,
            sourceType: "internal_repo",
            internalRepoPath,
            defaultBranch: branch,
          },
        })
      : await upsertInternalSandboxProject({
          teamId: input.teamId,
          projectName,
          branch,
          internalRepoPath,
          localProjectId: localProject.id,
        });
    const targetProjectId = stringValue(initialProjectRecord.id);
    if (!targetProjectId) throw new Error("OpenPond Cloud Project was created without an id.");

    const gitPayload = asRecord(
      await sandboxRequestPayload({
        type: "project_git",
        projectId: targetProjectId,
        payload: { teamId: input.teamId },
      }),
    );
    const repo = asRecord(gitPayload.repo);
    const repoUrl = stringValue(repo.repoUrl);
    if (!repoUrl) throw new Error("OpenPond Cloud Project did not return a Git remote URL.");
    const accountContext = await loadOpenPondAccountContext();
    const apiKey = accountContext.token?.trim();
    if (!apiKey) throw new Error("OpenPond account API key is required to push source.");

    const gitPush = await pushLocalProjectSourceToGit(localProject, {
      repoUrl,
      apiKey,
      branch,
      commitMessage: `Upload ${localProject.name} from OpenPond Desktop`,
      fallbackReadme,
    });
    const syncPayload = asRecord(
      await sandboxRequestPayload({
        type: "project_sync",
        projectId: targetProjectId,
        payload: { teamId: input.teamId },
      }).catch(() => gitPayload),
    );
    const uploadedProjectRecord = asRecord(syncPayload.project);
    const projectRecord =
      Object.keys(uploadedProjectRecord).length > 0
        ? uploadedProjectRecord
        : Object.keys(asRecord(gitPayload.project)).length > 0
          ? asRecord(gitPayload.project)
          : initialProjectRecord;
    const project = cloudProjectFromSandboxRecord(
      { ...projectRecord, teamId: input.teamId },
      input.teamId,
      projectName,
      branch,
    );
    const updatedLocalProject = await updateLocalProjectAgentSetup(store, localProject.id, {
      linkedSandboxProject: {
        teamId: input.teamId,
        projectId: project.id,
        projectSlug: project.slug,
        projectName: project.name,
        sourceRepoUrl: repoUrl,
        defaultBranch: project.defaultBranch ?? stringValue(repo.defaultBranch) ?? gitPush.branch,
        manifestPath: project.manifestPath,
        manifestHash: project.manifestHash,
        syncedAt: project.syncedAt ?? now(),
        linkedAt: linkedProject?.linkedAt ?? now(),
      },
    });

    return {
      project,
      localProject: updatedLocalProject,
      bootstrap: await bootstrapPayload({ forceOpenPond: true }),
      upload: {
        rootPath: gitPush.rootPath,
        branch: gitPush.branch,
        fileCount: gitPush.fileCount,
        byteCount: gitPush.byteCount,
        skippedCount: gitPush.skipped.length,
        initializedEmptyProject: gitPush.initializedEmptyProject,
      },
    };
  }

  async function listCloudWorkItemsPayload(payload: unknown): Promise<{ workItems: CloudWorkItem[] }> {
    const input = ListCloudWorkItemsRequestSchema.parse(payload);
    const workItemLists = await Promise.all(
      input.projectIds.map(async (projectId) => {
        const response = asRecord(
          await sandboxRequestPayload({
            type: "work_item_list",
            projectId,
            payload: {
              teamId: input.teamId,
              includeArchived: input.includeArchived,
              limit: input.limit ?? 100,
            },
          }),
        );
        return asRecordArray(response.workItems)
          .map(normalizeCloudWorkItem)
          .filter((item): item is CloudWorkItem => Boolean(item));
      }),
    );
    const byId = new Map<string, CloudWorkItem>();
    for (const workItem of workItemLists.flat()) {
      byId.set(workItem.id, workItem);
    }
    const workItems = [...byId.values()].sort(
      (left, right) => (Date.parse(right.updatedAt) || 0) - (Date.parse(left.updatedAt) || 0),
    );
    return { workItems };
  }

  async function getCloudWorkItemPayload(
    workItemId: string,
    payload: unknown,
  ): Promise<CloudWorkItemDetail> {
    const input = cloudWorkItemTeamInput(payload);
    const [workItemResponse, messagesResponse, activityResponse] = await Promise.all([
      sandboxRequestPayload({
        type: "work_item_get",
        workItemId,
        payload: { teamId: input.teamId, includeArchived: true },
      }),
      sandboxRequestPayload({
        type: "work_item_messages",
        workItemId,
        payload: { teamId: input.teamId, limit: 250 },
      }),
      sandboxRequestPayload({
        type: "work_item_activity",
        workItemId,
        payload: { teamId: input.teamId, limit: 250 },
      }),
    ]);
    const workItem = normalizeRequiredCloudWorkItem(asRecord(workItemResponse).workItem);
    const messages = asRecordArray(asRecord(messagesResponse).messages)
      .map(normalizeCloudWorkItemMessage)
      .filter((message): message is CloudWorkItemMessage => Boolean(message));
    const activity = asRecordArray(asRecord(activityResponse).activity)
      .map(normalizeCloudWorkItemActivity)
      .filter((item): item is CloudWorkItemActivity => Boolean(item));
    const latestCreatePipeline = latestCreatePipelineFromTimeline(workItem, messages, activity);
    const latestCreatePipelineRequest =
      latestCreatePipeline?.request ??
      latestCreatePipelineRequestFromTimeline(workItem, messages, activity) ??
      workItem.createPipelineRequest ??
      null;
    const workItemWithCreatePipeline = attachCreatePipelineToWorkItem(
      workItem,
      latestCreatePipelineRequest,
      latestCreatePipeline,
    );
    return CloudWorkItemDetailSchema.parse({
      workItem: workItemWithCreatePipeline,
      messages,
      activity,
      runtimeSessions: [],
      createPipelineRequest: workItemWithCreatePipeline.createPipelineRequest,
      createPipeline: workItemWithCreatePipeline.createPipeline,
    });
  }

  async function createCloudWorkItemPayload(payload: unknown): Promise<CloudWorkItemDetail> {
    const input = CreateCloudWorkItemRequestSchema.parse(payload);
    const {
      createPipelineRequest,
      createPipeline,
      ...workItemInput
    } = input;
    const response = asRecord(
      await sandboxRequestPayload({
        type: "work_item_create",
        projectId: input.projectId,
        payload: {
          ...workItemInput,
          metadata: {
            source: "openpond_app_cloud",
            ...createPipelineMetadata({
              request: createPipelineRequest ?? null,
              snapshot: createPipeline ?? null,
            }),
          },
        },
      }),
    );
    const createdWorkItem = normalizeRequiredCloudWorkItem(response.workItem);
    const linkedCreatePipeline = linkCreatePipelineToWorkItem({
      workItem: createdWorkItem,
      request: createPipelineRequest ?? null,
      snapshot: createPipeline ?? null,
    });
    if (linkedCreatePipeline.snapshot || linkedCreatePipeline.request) {
      await sandboxRequestPayload({
        type: "work_item_message_create",
        workItemId: createdWorkItem.id,
        payload: {
          teamId: input.teamId,
          role: "system",
          body: "Create pipeline metadata linked to this work item.",
          metadata: {
            source: "openpond_app_cloud_create_pipeline_link",
            hidden: true,
            ...createPipelineMetadata(linkedCreatePipeline),
          },
        },
      });
    }
    const workItem = attachCreatePipelineToWorkItem(
      createdWorkItem,
      linkedCreatePipeline.request,
      linkedCreatePipeline.snapshot,
    );
    return CloudWorkItemDetailSchema.parse({
      workItem,
      messages: [],
      activity: [],
      runtimeSessions: [],
      createPipelineRequest: workItem.createPipelineRequest,
      createPipeline: workItem.createPipeline,
    });
  }

  async function sendCloudWorkItemMessagePayload(
    workItemId: string,
    payload: unknown,
  ): Promise<{
    message: CloudWorkItemMessage;
    userMessage: CloudWorkItemMessage;
  }> {
    const input = SendCloudWorkItemMessageRequestSchema.parse(payload);
    assertCreatePipelineSnapshotLinked({
      actionLabel: "Cloud work item message create pipeline metadata",
      request: input.createPipelineRequest ?? null,
      snapshot: input.createPipeline ?? null,
    });
    const response = asRecord(
      await sandboxRequestPayload({
        type: "work_item_chat",
        workItemId,
        payload: {
          teamId: input.teamId,
          message: input.message,
          metadata: {
            source: "openpond_app_cloud_thread",
            ...createPipelineMetadata({
              request: input.createPipelineRequest ?? null,
              snapshot: input.createPipeline ?? null,
            }),
          },
        },
      }),
    );
    return {
      message: normalizeRequiredCloudWorkItemMessage(response.assistantMessage),
      userMessage: normalizeRequiredCloudWorkItemMessage(response.userMessage),
    };
  }

  async function handleCloudWorkItemBackgroundPayload(
    workItemId: string,
    payload: unknown,
  ): Promise<unknown> {
    const input = CloudWorkItemBackgroundRequestSchema.parse(payload);
    const {
      createPipelineRequest,
      createPipeline,
      payload: requestPayload,
      ...backgroundInput
    } = input;
    assertCreatePipelineSnapshotLinked({
      actionLabel: "Create pipeline background work",
      request: createPipelineRequest ?? null,
      snapshot: createPipeline ?? null,
    });
    assertCreatePipelineBackgroundApproved({
      request: createPipelineRequest ?? null,
      snapshot: createPipeline ?? null,
    });
    return sandboxRequestPayload({
      type: "work_item_handle_background",
      workItemId,
      payload: {
        ...backgroundInput,
        branchPolicy: input.branchPolicy ?? { mode: "patch_only" },
        payload: {
          source: "openpond_app_cloud_thread",
          ...(requestPayload ?? {}),
          ...createPipelineMetadata({
            request: createPipelineRequest ?? null,
            snapshot: createPipeline ?? null,
          }),
        },
      },
    });
  }

  async function cancelCloudWorkItemTaskPayload(
    workItemId: string,
    payload: unknown,
  ): Promise<unknown> {
    const input = cloudWorkItemTeamInput(payload);
    return sandboxRequestPayload({
      type: "work_item_cancel_task",
      workItemId,
      payload: {
        teamId: input.teamId,
      },
    });
  }

  async function openCloudWorkItemPayload(
    workItemId: string,
    payload: unknown,
  ): Promise<{
    workItem: CloudWorkItem;
    runtime?: unknown;
    session?: CloudWorkItemRuntimeSession;
    activity?: CloudWorkItemActivity;
    resumed?: boolean;
  }> {
    const input = OpenCloudWorkItemRequestSchema.parse(payload);
    const response = asRecord(
      await sandboxRequestPayload({
        type: "work_item_open_cloud",
        workItemId,
        payload: {
          ...input,
          payload: {
            source: "openpond_app_cloud_thread",
            ...(input.payload ?? {}),
          },
        },
      }),
    );
    return {
      ...response,
      workItem: normalizeRequiredCloudWorkItem(response.workItem),
      session: response.session ? normalizeCloudWorkItemRuntimeSession(response.session) ?? undefined : undefined,
      activity: response.activity ? normalizeCloudWorkItemActivity(response.activity) ?? undefined : undefined,
      resumed: response.resumed === true,
    };
  }

  async function currentSidebarScope(): Promise<string> {
    const context = await loadOpenPondAccountContext();
    return openPondCacheScope(context.accountState);
  }

  async function patchSidebarAppPreference(appId: string, payload: unknown): Promise<SidebarAppPreference> {
    const input = PatchSidebarAppPreferenceRequestSchema.parse(payload);
    return store.patchSidebarAppPreference(await currentSidebarScope(), appId, input);
  }

  async function reorderSidebarApps(payload: unknown): Promise<SidebarAppPreferences> {
    const input = ReorderSidebarAppsRequestSchema.parse(payload);
    return store.reorderSidebarApps(await currentSidebarScope(), input.appIds);
  }

  async function refreshOpenPondPayload(): Promise<BootstrapPayload> {
    const payload = await bootstrapPayload({ forceOpenPond: true });
    await appendRuntimeEvent(
      event({
        name: "diagnostic",
        source: "server",
        status: payload.appsError ? "failed" : "completed",
        output: payload.appsError
          ? `OpenPond refresh failed: ${payload.appsError}`
          : `OpenPond refresh loaded ${payload.apps.length} app${payload.apps.length === 1 ? "" : "s"}.`,
      })
    );
    return payload;
  }

  async function loadMoreOpenPondAppsPayload(requestUrl: URL): Promise<unknown> {
    const limit = Math.min(Math.max(Number(requestUrl.searchParams.get("limit") ?? "10") || 10, 1), 50);
    const offset = Math.max(Number(requestUrl.searchParams.get("offset") ?? "20") || 20, 0);
    const result = await loadOpenPondApps({ limit, offset, includeScheduled: true });
    const account = AccountStateSchema.parse(result.account);
    const scope = openPondCacheScope(account);
    const cachedApps = await store.getCacheEntry<OpenPondApp[]>("openpond.apps", scope);
    const existing = cachedApps?.payload ?? [];
    const merged = appendAppPage(existing, result.apps);
    await store.setCacheEntry("openpond.account", scope, account, account.error);
    const appsEntry = await store.setCacheEntry("openpond.apps", scope, merged.apps, result.error);
    const payload = await bootstrapPayload();
    return {
      bootstrap: {
        ...payload,
        apps: await mergeScaffoldApps(scope, appsEntry.payload),
        appsError: result.error ?? payload.appsError,
        appsMeta: metaFromCache(appsEntry, "fresh", false, result.error),
      },
      addedCount: merged.addedCount,
      limit,
      offset,
      hasMore: result.apps.length >= limit,
    };
  }

  async function switchOpenPondPayload(payload: unknown): Promise<BootstrapPayload> {
    const input = SwitchOpenPondAccountRequestSchema.parse(payload);
    await switchOpenPondAccount(input);
    await appendRuntimeEvent(
      event({
        name: "diagnostic",
        source: "server",
        action: "openpond.account.switch",
        status: "completed",
        output: `Switched OpenPond account to ${input.handle}.`,
      })
    );
    return bootstrapPayload({ forceOpenPond: true });
  }

  async function saveOpenPondAccountPayload(payload: unknown): Promise<BootstrapPayload> {
    const input = SaveOpenPondAccountRequestSchema.parse(payload);
    await saveOpenPondAccount({
      handle: input.handle,
      apiKey: input.apiKey,
      baseUrl: input.baseUrl ?? undefined,
      apiBaseUrl: input.apiBaseUrl ?? undefined,
      chatApiBaseUrl: input.chatApiBaseUrl ?? undefined,
      environment: input.environment ?? undefined,
      setActive: input.setActive,
    });
    await appendRuntimeEvent(
      event({
        name: "diagnostic",
        source: "server",
        action: "openpond.account.save",
        status: "completed",
        output: "Saved OpenPond account.",
      })
    );
    return bootstrapPayload({ forceOpenPond: true });
  }

  async function profileCurrentPayload() {
    return loadOpenPondProfileState();
  }

  async function profileCatalogPayload() {
    const profile = await loadOpenPondProfileState();
    return {
      profile,
      catalog: profile.catalog,
      actions: profile.actionCatalog,
    };
  }

  async function profileInitPayload(payload: unknown) {
    const input = asRecord(payload);
    const state = await initLocalProfileRepo({
      repoPath: stringValue(input.path) ?? stringValue(input.repoPath) ?? undefined,
      profile: stringValue(input.profile) ?? undefined,
      template: stringValue(input.template) ?? undefined,
      force: booleanValue(input.force) ?? false,
    });
    await appendRuntimeEvent(
      event({
        name: "diagnostic",
        source: "server",
        action: "openpond.profile.init",
        status: "completed",
        output: `Initialized OpenPond profile ${state.activeProfile ?? "default"}.`,
      })
    );
    return state;
  }

  async function profileLoadPayload(payload: unknown) {
    const input = asRecord(payload);
    const repoPath = stringValue(input.path) ?? stringValue(input.repoPath);
    if (!repoPath) throw new Error("Profile repo path is required.");
    const state = await loadLocalProfileRepo(repoPath, stringValue(input.profile) ?? undefined);
    await appendRuntimeEvent(
      event({
        name: "diagnostic",
        source: "server",
        action: "openpond.profile.load",
        status: "completed",
        output: `Loaded OpenPond profile ${state.activeProfile ?? "default"}.`,
      })
    );
    return state;
  }

  async function profileCheckPayload(payload: unknown) {
    const input = asRecord(payload);
    const kind = stringValue(input.kind) ?? "all";
    await runProfileCheck(kind);
    const state = await loadOpenPondProfileState();
    await appendRuntimeEvent(
      event({
        name: "diagnostic",
        source: "server",
        action: "openpond.profile.check",
        status: "completed",
        output: `Profile check completed for ${kind}.`,
      })
    );
    return state;
  }

  async function profileCommitPayload(payload: unknown) {
    const input = asRecord(payload);
    const result = await commitActiveProfileChanges(stringValue(input.message) ?? stringValue(input.commitMessage) ?? undefined);
    await appendRuntimeEvent(
      event({
        name: "diagnostic",
        source: "server",
        action: "openpond.profile.commit",
        status: "completed",
        output: result.committed ? "Committed OpenPond profile changes." : "No OpenPond profile changes to commit.",
      })
    );
    return result;
  }

  async function profilePushPayload(payload: unknown) {
    const input = asRecord(payload);
    const teamId = stringValue(input.teamId);
    if (!teamId) throw new Error("teamId is required.");
    const profile = await loadOpenPondProfileState();
    if (profile.error) throw new Error(profile.error);
    if (!profile.repoPath || !profile.sourcePath || !profile.manifestPath) {
      throw new Error("No active OpenPond profile. Run `openpond init`.");
    }
    if (!profile.git?.isRepo) {
      throw new Error("Active OpenPond profile source is not Git-backed.");
    }
    if (!profile.git.head) {
      throw new Error("Profile source must have a committed Git head before push.");
    }
    if (profile.git.dirty) {
      throw new Error("Profile source has uncommitted changes. Commit before pushing.");
    }

    const hostedPayload = asRecord(
      await sandboxRequestPayload({
        type: booleanValue(input.ensureHosted) ? "profile_ensure" : "profile_get",
        payload: { teamId },
      }),
    );
    const hostedProfile = asRecord(hostedPayload.profile);
    if (!hostedProfile) {
      throw new Error("No hosted OpenPond profile repo found. Run `openpond profile ensure-hosted` first.");
    }
    const sourceUpload = asRecord(hostedProfile.sourceUpload);
    const currentHostedHead = stringValue(sourceUpload?.sourceCommitSha) ?? null;
    const lastPushedHostedHead = profile.hosted?.sourceCommitSha ?? null;
    if (lastPushedHostedHead && currentHostedHead !== lastPushedHostedHead && !booleanValue(input.force)) {
      throw new Error("Hosted profile source changed since the last local push. Inspect hosted changes or push with force.");
    }

    const manifest = JSON.parse(await readFile(profile.manifestPath, "utf8")) as ProfileRepoManifest;
    const sourcePath = manifest.profiles[profile.activeProfile ?? manifest.defaultProfile]?.path ?? "profiles/default";
    const upload = await collectProfileSourceUploadEntries(profile.repoPath);
    const pushPayload = asRecord(
      await sandboxRequestPayload({
        type: "profile_push",
        payload: {
          teamId,
          entries: upload.entries,
          branch: profile.git.branch ?? "main",
          commitMessage:
            stringValue(input.commitMessage) ??
            stringValue(input.message) ??
            `Push OpenPond profile ${profile.activeProfile ?? "default"} at ${profile.git.shortHead ?? profile.git.head}`,
          expectedSourceCommitSha: currentHostedHead,
          localHeadSha: profile.git.head,
          manifest,
          sourcePath,
          agents: profile.agents.map((agent) => ({
            id: agent.id,
            path: agent.path,
            enabled: agent.enabled,
          })),
        },
      }),
    );
    const pushedProfile = asRecord(pushPayload.profile);
    const pushedSourceUpload = asRecord(pushPayload.sourceUpload);
    const pushedAt = new Date().toISOString();
    let pushStatus: LocalOpenPondProfilePushStatus = {
      status: "pushed",
      promotionStatus: "uploaded",
      hostedRunStatus: "not_started",
      pushedAt,
      teamId,
      projectId: stringValue(asRecord(pushedProfile?.project)?.id),
      localHead: profile.git.head,
      hostedHead: stringValue(pushedSourceUpload?.sourceCommitSha),
      sourceRef: stringValue(pushedSourceUpload?.sourceRef),
    };
    await saveProfilePushStatus(pushStatus);

    const hostedSourceAgentId =
      stringValue(input.hostedSourceAgentId) ?? stringValue(input.hostedRunAgentId);
    const requestHostedSourceChecks = Boolean(booleanValue(input.hostedSourceChecks));
    const publishHostedSource = Boolean(booleanValue(input.publishHostedSource));
    const hostedSourceDispatch =
      parseHostedSourceDispatch(stringValue(input.hostedSourceDispatch)) ?? "coding_core";
    let hostedSourceDeployPlan: Record<string, unknown> | null = null;
    let hostedSourceChecks: Record<string, unknown> | null = null;
    let hostedSourcePublish: Record<string, unknown> | null = null;
    if (requestHostedSourceChecks || publishHostedSource) {
      if (!hostedSourceAgentId) {
        throw new Error("hostedSourceAgentId or hostedRunAgentId is required for hosted source checks or publish.");
      }
      try {
        const deployPlanPayload = asRecord(
          await sandboxRequestPayload({
            type: "agent_source_deploy_plan",
            agentId: hostedSourceAgentId,
            payload: { teamId },
          }),
        );
        hostedSourceDeployPlan = asRecord(deployPlanPayload.deployPlan);
        if (requestHostedSourceChecks) {
          hostedSourceChecks = asRecord(
            await sandboxRequestPayload({
              type: "agent_source_checks",
              agentId: hostedSourceAgentId,
              payload: {
                teamId,
                sourceRef: stringValue(pushedSourceUpload?.sourceRef),
                baseSha: stringValue(pushedSourceUpload?.sourceCommitSha),
                checkKind: stringValue(input.hostedCheckKind) ?? stringValue(input.checkKind) ?? "all",
                dispatch: hostedSourceDispatch,
                metadata: {
                  source: "openpond_profile_push_checks",
                  localHead: profile.git.head,
                  hostedHead: stringValue(pushedSourceUpload?.sourceCommitSha),
                  sourceRef: stringValue(pushedSourceUpload?.sourceRef),
                  dispatch: hostedSourceDispatch,
                },
              },
            }),
          );
          const dispatchResult = asRecord(hostedSourceChecks.dispatchResult);
          if (stringValue(dispatchResult.status) === "failed") {
            throw new Error(stringValue(dispatchResult.error) ?? "hosted_source_check_dispatch_failed");
          }
        }
        pushStatus = {
          ...pushStatus,
          promotionStatus: requestHostedSourceChecks ? "hosted_source_check_pending" : pushStatus.promotionStatus,
          hostedSourceCheck: hostedSourceCheckStatusFromPayload({
            agentId: hostedSourceAgentId,
            status: requestHostedSourceChecks ? "requested" : "deploy_plan_ready",
            deployPlan: hostedSourceDeployPlan,
            checkResult: hostedSourceChecks,
          }),
        };
        await saveProfilePushStatus(pushStatus);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        pushStatus = {
          ...pushStatus,
          promotionStatus: "hosted_source_check_failed",
          hostedSourceCheck: hostedSourceCheckStatusFromPayload({
            agentId: hostedSourceAgentId,
            status: "failed",
            deployPlan: hostedSourceDeployPlan,
            checkedAt: new Date().toISOString(),
            error: message,
          }),
          error: message,
        };
        await saveProfilePushStatus(pushStatus);
        throw new Error(`Hosted source check failed after push: ${message}`);
      }
    }

    if (publishHostedSource) {
      if (!hostedSourceAgentId) {
        throw new Error("hostedSourceAgentId or hostedRunAgentId is required for hosted source publish.");
      }
      try {
        const deployPlanSource = asRecord(hostedSourceDeployPlan?.source);
        const expectedManifestHash =
          stringValue(input.expectedManifestHash) ??
          pushStatus.hostedSourceCheck?.manifestHash ??
          stringValue(deployPlanSource?.manifestHash);
        hostedSourcePublish = asRecord(
          await sandboxRequestPayload({
            type: "agent_source_publish",
            agentId: hostedSourceAgentId,
            payload: {
              teamId,
              expectedManifestHash,
              expectedSourceCommitSha: stringValue(pushedSourceUpload?.sourceCommitSha),
              workItemId: stringValue(input.workItemId),
            },
          }),
        );
        pushStatus = {
          ...pushStatus,
          promotionStatus: "hosted_source_published",
          hostedPublish: hostedPublishStatusFromPayload({
            agentId: hostedSourceAgentId,
            publishResult: hostedSourcePublish,
          }),
        };
        await saveProfilePushStatus(pushStatus);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        pushStatus = {
          ...pushStatus,
          promotionStatus: "hosted_source_publish_failed",
          hostedPublish: {
            status: "failed",
            agentId: hostedSourceAgentId,
            error: message,
          },
          error: message,
        };
        await saveProfilePushStatus(pushStatus);
        throw new Error(`Hosted source publish failed after push: ${message}`);
      }
    }

    const hostedRunAgentId = stringValue(input.hostedRunAgentId);
    let hostedRun: Record<string, unknown> | null = null;
    if (hostedRunAgentId) {
      const hostedRunStartedAt = new Date().toISOString();
      const hostedRunInput = nonEmptyRecord(input.hostedRunInput)
        ?? { prompt: "hello", channel: "openpond_chat" };
      const hostedRunIdempotencyKey = buildProfileHostedRunIdempotencyKey({
        input,
        localHead: profile.git.head,
        hostedHead: stringValue(pushedSourceUpload?.sourceCommitSha),
        hostedRunAgentId,
        hostedRunInput,
      });
      await saveProfilePushStatus({
        ...pushStatus,
        promotionStatus: "hosted_run_pending",
        hostedRunStatus: "running",
        hostedRunAgentId,
        hostedRunAt: hostedRunStartedAt,
      });
      try {
        hostedRun = asRecord(
          await sandboxRequestPayload({
            type: "agent_run",
            agentId: hostedRunAgentId,
            payload: {
              teamId,
              idempotencyKey: hostedRunIdempotencyKey,
              input: hostedRunInput,
              metadata: {
                source: "openpond_profile_push_run",
                localHead: profile.git.head,
                hostedHead: stringValue(pushedSourceUpload?.sourceCommitSha),
                hostedRunIdempotencyKey,
                hostedRunRetry: Boolean(booleanValue(input.hostedRunRetry)),
                sourceRef: stringValue(pushedSourceUpload?.sourceRef),
                publishedSnapshotId: pushStatus.hostedPublish?.snapshotId ?? null,
                manifestHash:
                  pushStatus.hostedPublish?.manifestHash ??
                  pushStatus.hostedSourceCheck?.manifestHash ??
                  null,
              },
              runtimeSourcePolicy: publishHostedSource
                ? {
                    requirePublishedSnapshot: true,
                    source: "diagnostic",
                  }
                : {
                    allowLatestSource: true,
                    source: "diagnostic",
                  },
            },
          }),
        );
        const run = asRecord(hostedRun.run);
        const hostedRunSummary = hostedRunSummaryFromPayload({
          agentId: hostedRunAgentId,
          runResult: hostedRun,
        });
        const hostedRunStatus = hostedRunStatusFromRunSummary(hostedRunSummary);
        await saveProfilePushStatus({
          ...pushStatus,
          promotionStatus:
            hostedRunStatus === "passed"
              ? "hosted_run_passed"
              : hostedRunStatus === "failed"
                ? "hosted_run_failed"
                : "hosted_run_pending",
          hostedRunStatus,
          hostedRunAgentId,
          hostedRunId: stringValue(run.id),
          hostedRunAt: stringValue(run.createdAt) ?? hostedRunStartedAt,
          hostedRun: hostedRunSummary,
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        await saveProfilePushStatus({
          ...pushStatus,
          promotionStatus: "hosted_run_failed",
          hostedRunStatus: "failed",
          hostedRunAgentId,
          hostedRunAt: new Date().toISOString(),
          hostedRun: {
            status: "failed",
            agentId: hostedRunAgentId,
            error: message,
          },
          error: message,
        });
        throw new Error(`Hosted invocation failed to start after push: ${message}`);
      }
    }
    await appendRuntimeEvent(
      event({
        name: "diagnostic",
        source: "server",
        action: "openpond.profile.push",
        status: "completed",
        output: `Pushed OpenPond profile ${profile.activeProfile ?? "default"}.`,
      })
    );
    return {
      ...pushPayload,
      hostedSourceChecks,
      hostedSourcePublish,
      hostedRun,
      uploaded: upload,
      localProfile: await loadOpenPondProfileState(),
    };
  }

  async function profileRunPayload(payload: unknown) {
    const input = asRecord(payload);
    const action = stringValue(input.action) ?? stringValue(input.actionName);
    if (!action) throw new Error("Profile action name is required.");
    const metadata = asRecord(input.metadata);
    const actionInput = asRecord(input.input);
    const sessionId = stringValue(metadata.sessionId);
    const prompt = stringValue(actionInput.prompt) ?? stringValue(actionInput.message) ?? `Run ${action}`;
    const displayPrompt = stringValue(metadata.displayPrompt) ?? prompt;
    const selectedActionLabel =
      stringValue(metadata.selectedActionLabel) ??
      stringValue(metadata.selectedActionId) ??
      action;
    const args = [action];
    if (input.input !== undefined) {
      args.push("--input", JSON.stringify(input.input));
    }
    const result = await runProfileSdkCommand({
      command: "run",
      args,
    });
    const runSummary = profileActionRunSummary({
      action,
      code: result.code,
      stderr: result.stderr,
      stdout: result.stdout,
    });
    if (sessionId) {
      const turnId = `openpond_profile_action_${Date.now()}`;
      await appendRuntimeEvent(
        event({
          name: "turn.started",
          sessionId,
          turnId,
          source: "chat_action",
          args: { prompt: displayPrompt },
        }),
      );
      await appendRuntimeEvent(
        event({
          name: "workspace_action_result",
          sessionId,
          turnId,
          source: "chat_action",
          action: "profile_run_action",
          appId: null,
          status: runSummary.status,
          output: runSummary.output,
          data: {
            openPondProfileActionRun: true,
            action: {
              name: action,
              label: selectedActionLabel,
              implementation: { type: "openpond-profile-action", actionId: action },
            },
            stdout: result.stdout,
            stderr: result.stderr,
            code: result.code,
            responseSummary: runSummary.responseSummary,
            artifactRefs: runSummary.artifactRefs,
            traceArtifactRefs: runSummary.traceArtifactRefs,
          },
        }),
      );
    }
    await appendRuntimeEvent(
      event({
        name: "diagnostic",
        source: "server",
        action: "openpond.profile.run",
        status: "completed",
        output: `Ran profile action ${action}.`,
      })
    );
    return {
      action,
      stdout: result.stdout,
      stderr: result.stderr,
      code: result.code,
    };
  }

  return {
    openPondCacheScope,
    upsertScaffoldApp,
    loadAppPreferences,
    loadProvidersFile,
    loadProviderSettings,
    updateAppPreferencesPayload,
    providerSettingsPayload,
    updateProviderSettingsPayload,
    listProviderModelsPayload,
    refreshProviderModelsPayload,
    writeProviderCredentialPayload,
    deleteProviderCredentialPayload,
    validateProviderCredentialPayload,
    providerDiagnosticsPayload,
    updatePersonalizationPayload,
    bootstrapPayload,
    findOpenPondApp,
    codexHistoryThreadPayload,
    patchCodexHistorySessionPayload,
    sendCodexHistoryTurnPayload,
    interruptCodexHistoryTurnPayload,
    ...workspacePayloads,
    uploadLocalProjectCloudSourcePayload,
    listCloudWorkItemsPayload,
    getCloudWorkItemPayload,
    createCloudWorkItemPayload,
    sendCloudWorkItemMessagePayload,
    handleCloudWorkItemBackgroundPayload,
    cancelCloudWorkItemTaskPayload,
    openCloudWorkItemPayload,
    patchSidebarAppPreference,
    reorderSidebarApps,
    refreshOpenPondPayload,
    loadMoreOpenPondAppsPayload,
    switchOpenPondPayload,
    saveOpenPondAccountPayload,
    profileCurrentPayload,
    profileCatalogPayload,
    profileInitPayload,
    profileLoadPayload,
    profileCheckPayload,
    profileCommitPayload,
    profilePushPayload,
    profileRunPayload,
    waitForOpenPondRefresh,
  };
}

function internalRepoPathForLocalProject(project: LocalProject): string {
  const slug = slugifyInternalRepoSegment(project.name);
  const suffix = project.id.replace(/^local_/, "").replace(/[^a-z0-9]/gi, "").slice(0, 16);
  return `desktop-${slug}-${suffix || "project"}`;
}

function slugifyInternalRepoSegment(value: string): string {
  const slug = value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48);
  return slug || "project";
}

async function sandboxProjectRecordOrFallback(input: {
  projectId: string;
  teamId: string;
  fallback: Record<string, unknown>;
}): Promise<Record<string, unknown>> {
  try {
    const payload = asRecord(
      await sandboxRequestPayload({
        type: "project_get",
        projectId: input.projectId,
        payload: { teamId: input.teamId },
      }),
    );
    const project = asRecord(payload.project);
    return Object.keys(project).length > 0 ? project : input.fallback;
  } catch {
    return input.fallback;
  }
}

async function upsertInternalSandboxProject(input: {
  teamId: string;
  projectName: string;
  branch: string;
  internalRepoPath: string;
  localProjectId: string;
}): Promise<Record<string, unknown>> {
  const payload = asRecord(
    await sandboxRequestPayload({
      type: "project_upsert",
      payload: {
        teamId: input.teamId,
        name: input.projectName,
        sourceType: "internal_repo",
        normalizedSourceIdentity: input.internalRepoPath,
        defaultBranch: input.branch,
        sourceConfig: {
          sourceType: "internal_repo",
          sourceValue: input.internalRepoPath,
        },
        metadata: {
          source: "openpond-app-local-project-cloud-setup",
          localProjectId: input.localProjectId,
        },
      },
    }),
  );
  const project = asRecord(payload.project);
  if (Object.keys(project).length === 0) {
    throw new Error("OpenPond Cloud Project response did not include a project.");
  }
  return project;
}

function cloudProjectFromSandboxRecord(
  value: Record<string, unknown>,
  teamId: string,
  fallbackName: string,
  fallbackBranch: string,
): CloudProject {
  const normalized = normalizeCloudProject(
    { ...value, teamId },
    { teamId, slug: null, displayName: null },
  );
  if (normalized) return normalized;
  const id = stringValue(value.id);
  if (!id) throw new Error("OpenPond Cloud Project response did not include a project id.");
  return {
    id,
    teamId,
    name: stringValue(value.name) ?? fallbackName,
    slug: stringValue(value.slug),
    sourceType: normalizeCloudProjectSourceType(value.sourceType),
    sourceLabel: cloudProjectSourceLabel(value, normalizeCloudProjectSourceType(value.sourceType)),
    defaultBranch: stringValue(value.defaultBranch) ?? stringValue(value.gitBranch) ?? fallbackBranch,
    internalRepoPath: stringValue(value.internalRepoPath),
    manifestPath: stringValue(value.sandboxManifestPath),
    manifestHash: stringValue(value.sandboxManifestHash),
    syncedAt: stringValue(value.sandboxManifestSyncedAt),
    agentSdk: cloudProjectAgentSdk(value),
    organizationName: null,
    organizationSlug: null,
    createdAt: stringValue(value.createdAt),
    updatedAt: stringValue(value.updatedAt),
  };
}

function cloudWorkItemTeamInput(payload: unknown): { teamId: string } {
  const teamId = stringValue(asRecord(payload).teamId);
  if (!teamId) throw new Error("OpenPond team id is required.");
  return { teamId };
}

function parseCreatePipelineRequest(value: unknown): CreatePipelineRequest | null {
  const parsed = CreatePipelineRequestSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}

function parseCreatePipelineSnapshot(value: unknown): CreatePipelineSnapshot | null {
  const parsed = CreatePipelineSnapshotSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}

function createPipelineMetadata(input: {
  request?: CreatePipelineRequest | null;
  snapshot?: CreatePipelineSnapshot | null;
}): Record<string, unknown> {
  return {
    ...(input.request ? { createPipelineRequest: input.request } : {}),
    ...(input.snapshot ? { createPipeline: input.snapshot } : {}),
  };
}

function linkCreatePipelineToWorkItem(input: {
  workItem: CloudWorkItem;
  request: CreatePipelineRequest | null;
  snapshot: CreatePipelineSnapshot | null;
}): {
  request: CreatePipelineRequest | null;
  snapshot: CreatePipelineSnapshot | null;
} {
  const requestSource = input.snapshot?.request ?? input.request;
  const request = requestSource
    ? CreatePipelineRequestSchema.parse({
        ...requestSource,
        adapter:
          requestSource.adapter.kind === "hosted"
            ? {
                ...requestSource.adapter,
                projectId: input.workItem.projectId,
                workItemId: input.workItem.id,
              }
            : requestSource.adapter,
        scope: {
          ...requestSource.scope,
          conversationId: input.workItem.conversationId ?? requestSource.scope.conversationId,
          workItemId: input.workItem.id,
          projectId: input.workItem.projectId,
        },
        metadata: {
          ...requestSource.metadata,
          workItemId: input.workItem.id,
          conversationId: input.workItem.conversationId,
          projectId: input.workItem.projectId,
        },
      })
    : null;
  const snapshot = input.snapshot
    ? CreatePipelineSnapshotSchema.parse({
        ...input.snapshot,
        goalId: input.workItem.id,
        request: request ?? input.snapshot.request,
        plan: input.snapshot.plan
          ? {
              ...input.snapshot.plan,
              goalId: input.workItem.id,
              metadata: {
                ...input.snapshot.plan.metadata,
                workItemId: input.workItem.id,
                conversationId: input.workItem.conversationId,
                projectId: input.workItem.projectId,
              },
            }
          : null,
        workflowCapture: input.snapshot.workflowCapture
          ? {
              ...input.snapshot.workflowCapture,
              goalId: input.workItem.id,
              metadata: {
                ...input.snapshot.workflowCapture.metadata,
                workItemId: input.workItem.id,
                conversationId: input.workItem.conversationId,
                projectId: input.workItem.projectId,
              },
            }
          : null,
        metadata: {
          ...input.snapshot.metadata,
          workItemId: input.workItem.id,
          conversationId: input.workItem.conversationId,
          projectId: input.workItem.projectId,
        },
      })
    : null;
  return {
    request: request ?? snapshot?.request ?? null,
    snapshot,
  };
}

function extractCreatePipelineSnapshot(record: Record<string, unknown>): CreatePipelineSnapshot | null {
  const metadata = asRecord(record.metadata);
  const payload = asRecord(record.payload);
  return (
    parseCreatePipelineSnapshot(record.createPipeline) ??
    parseCreatePipelineSnapshot(record.createPipelineSnapshot) ??
    parseCreatePipelineSnapshot(metadata.createPipeline) ??
    parseCreatePipelineSnapshot(metadata.createPipelineSnapshot) ??
    parseCreatePipelineSnapshot(payload.createPipeline) ??
    parseCreatePipelineSnapshot(payload.createPipelineSnapshot)
  );
}

function extractCreatePipelineRequest(
  record: Record<string, unknown>,
  snapshot: CreatePipelineSnapshot | null,
): CreatePipelineRequest | null {
  const metadata = asRecord(record.metadata);
  const payload = asRecord(record.payload);
  return (
    parseCreatePipelineRequest(record.createPipelineRequest) ??
    parseCreatePipelineRequest(metadata.createPipelineRequest) ??
    parseCreatePipelineRequest(payload.createPipelineRequest) ??
    parseCreatePipelineRequest(asRecord(record.createPipeline).request) ??
    parseCreatePipelineRequest(asRecord(metadata.createPipeline).request) ??
    parseCreatePipelineRequest(asRecord(payload.createPipeline).request) ??
    snapshot?.request ??
    null
  );
}

function attachCreatePipelineToWorkItem(
  workItem: CloudWorkItem,
  request: CreatePipelineRequest | null,
  snapshot: CreatePipelineSnapshot | null,
): CloudWorkItem {
  return {
    ...workItem,
    createPipelineRequest: request ?? workItem.createPipelineRequest ?? snapshot?.request ?? null,
    createPipeline: snapshot ?? workItem.createPipeline ?? null,
  };
}

function latestCreatePipelineFromTimeline(
  workItem: CloudWorkItem,
  messages: CloudWorkItemMessage[],
  activity: CloudWorkItemActivity[],
): CreatePipelineSnapshot | null {
  let latest = workItem.createPipeline ?? null;
  for (const item of [...messages, ...activity]) {
    const snapshot = parseCreatePipelineSnapshot(asRecord(item.metadata).createPipeline);
    if (snapshot) latest = snapshot;
  }
  return latest;
}

function latestCreatePipelineRequestFromTimeline(
  workItem: CloudWorkItem,
  messages: CloudWorkItemMessage[],
  activity: CloudWorkItemActivity[],
): CreatePipelineRequest | null {
  let latest = workItem.createPipelineRequest ?? null;
  for (const item of [...messages, ...activity]) {
    const metadata = asRecord(item.metadata);
    const request =
      parseCreatePipelineRequest(metadata.createPipelineRequest) ??
      parseCreatePipelineRequest(asRecord(metadata.createPipeline).request);
    if (request) latest = request;
  }
  return latest;
}

function normalizeCloudWorkItem(value: unknown): CloudWorkItem | null {
  const record = asRecord(value);
  if (!stringValue(record.id)) return null;
  const createPipeline = extractCreatePipelineSnapshot(record);
  const createPipelineRequest = extractCreatePipelineRequest(record, createPipeline);
  const parsed = CloudWorkItemSchema.safeParse({
    ...record,
    conversationId: stringValue(record.conversationId),
    sourceRef: stringValue(record.sourceRef),
    baseSha: stringValue(record.baseSha),
    latestRuntimeId: stringValue(record.latestRuntimeId),
    latestSandboxId: stringValue(record.latestSandboxId),
    latestTaskRunId: stringValue(record.latestTaskRunId),
    assignedAgentId: stringValue(record.assignedAgentId),
    archivedAt: stringValue(record.archivedAt),
    metadata: asRecord(record.metadata),
    createPipelineRequest,
    createPipeline,
  });
  return parsed.success ? parsed.data : null;
}

function normalizeRequiredCloudWorkItem(value: unknown): CloudWorkItem {
  const workItem = normalizeCloudWorkItem(value);
  if (!workItem) throw new Error("OpenPond Cloud work item response did not include a work item.");
  return workItem;
}

function normalizeCloudWorkItemMessage(value: unknown): CloudWorkItemMessage | null {
  const record = asRecord(value);
  if (!stringValue(record.id)) return null;
  const parsed = CloudWorkItemMessageSchema.safeParse({
    ...record,
    metadata: Object.keys(asRecord(record.metadata)).length > 0
      ? asRecord(record.metadata)
      : asRecord(record.payload),
  });
  return parsed.success ? parsed.data : null;
}

function normalizeRequiredCloudWorkItemMessage(value: unknown): CloudWorkItemMessage {
  const message = normalizeCloudWorkItemMessage(value);
  if (!message) throw new Error("OpenPond Cloud work item response did not include a message.");
  return message;
}

function normalizeCloudWorkItemActivity(value: unknown): CloudWorkItemActivity | null {
  const record = asRecord(value);
  if (!stringValue(record.id)) return null;
  const parsed = CloudWorkItemActivitySchema.safeParse({
    ...record,
    metadata: Object.keys(asRecord(record.metadata)).length > 0
      ? asRecord(record.metadata)
      : asRecord(record.payload),
  });
  return parsed.success ? parsed.data : null;
}

function normalizeCloudWorkItemRuntimeSession(value: unknown): CloudWorkItemRuntimeSession | null {
  const record = asRecord(value);
  if (!stringValue(record.id)) return null;
  const parsed = CloudWorkItemRuntimeSessionSchema.safeParse({
    ...record,
    kind: stringValue(record.kind) ?? stringValue(record.sessionKind),
    metadata: asRecord(record.metadata),
  });
  return parsed.success ? parsed.data : null;
}

function codexHistoryThreadReadOptions(requestUrl: URL | undefined): {
  maxEvents?: number;
  tail?: boolean;
} {
  if (!requestUrl) return {};
  const maxEvents = positiveIntegerParam(requestUrl.searchParams.get("limit"));
  return {
    ...(maxEvents ? { maxEvents } : {}),
    tail: requestUrl.searchParams.get("tail") === "1",
  };
}

function nextCodexHistoryTurnId(events: RuntimeEvent[], sessionId: string): string {
  const prefix = `${sessionId}_turn_`;
  let maxTurnIndex = 0;
  for (const event of events) {
    const turnId = event.turnId;
    if (!turnId?.startsWith(prefix)) continue;
    const value = turnId.slice(prefix.length);
    if (!/^\d+$/.test(value)) continue;
    maxTurnIndex = Math.max(maxTurnIndex, Number.parseInt(value, 10));
  }
  return `${prefix}${maxTurnIndex + 1}`;
}

function positiveIntegerParam(value: string | null): number | undefined {
  if (!value) return undefined;
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) return undefined;
  return Math.min(50_000, parsed);
}

const CODEX_HISTORY_BASE_SESSION_CONFIG = {
  "tools.web_search": true,
  "tools.view_image": true,
  "features.web_search_request": true,
};

function codexHistorySessionConfig(permissionMode: "default" | "auto-review" | "full-access"): Record<string, unknown> {
  return {
    ...CODEX_HISTORY_BASE_SESSION_CONFIG,
    approvals_reviewer: permissionMode === "auto-review" ? "auto_review" : "user",
  };
}
