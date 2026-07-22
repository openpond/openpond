import { randomUUID } from "node:crypto";
import path from "node:path";

import {
  AccountStateSchema,
  BootstrapPayloadSchema,
  CloudWorkItemDetailSchema,
  CloudWorkItemBackgroundRequestSchema,
  CreateCloudWorkItemRequestSchema,
  ApplyCloudWorkItemLocalPatchRequestSchema,
  ListCloudWorkItemsRequestSchema,
  OpenCloudWorkItemRequestSchema,
  PatchSidebarAppPreferenceRequestSchema,
  PatchSidebarFileBookmarkRequestSchema,
  RecordClientDiagnosticRequestSchema,
  RecordPreflightTurnFailureRequestSchema,
  PreviewLocalProjectCloudSourceRequestSchema,
  ReorderSidebarAppsRequestSchema,
  SaveOpenPondAccountRequestSchema,
  SendCloudWorkItemMessageRequestSchema,
  SessionSchema,
  SwitchOpenPondAccountRequestSchema,
  UpdateOpenPondAccountConfigRequestSchema,
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
  type CloudWorkItem,
  type CloudWorkItemActivity,
  type CloudWorkItemDetail,
  type CloudWorkItemMessage,
  type CloudWorkItemRuntimeSession,
  type CodexStatus,
  type LocalProject,
  type OpenPondApp,
  type RuntimeEvent,
  type ProviderCatalog,
  type ProviderSettings,
  type Session,
  type SidebarAppPreference,
  type SidebarAppPreferences,
  type SidebarFileBookmark,
  type SidebarFileBookmarksResponse,
  type PatchSidebarFileBookmarkRequest,
  type WorkspaceState,
  normalizeSidebarFilePath,
} from "@openpond/contracts";
import {
  loadOpenPondAccountContext,
  loadOpenPondApps,
  saveOpenPondAccount,
  switchOpenPondAccount,
  updateOpenPondAccountConfig,
} from "@openpond/runtime";
import { emptyProfileState, initLocalProfileRepo, loadOpenPondProfileState } from "@openpond/cloud";
import { loadGlobalConfig, saveGlobalConfig } from "@openpond/cloud/config";
import { APP_PREFERENCES_CACHE_KEY, APP_PREFERENCES_CACHE_TYPE } from "../constants.js";
import {
  assertCreateImproveRunLinked,
} from "../create-pipeline-guards.js";
import { normalizeAppPreferences } from "../preferences.js";
import { loadPersonalizationSettings, savePersonalizationSettings } from "../openpond/personalization.js";
import {
  loadCodexPersonalSkills,
  readCodexPersonalSkillFile,
  readSkillSourceFile,
} from "../codex-personal-skills.js";
import {
  mergeProviderConfigPatch,
  normalizeProvidersFile,
  readProvidersFile,
  updateProvidersFile,
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
import { createOpenAiSubscriptionAuthService } from "../openpond/openai-subscription-auth.js";
import { ProviderDiagnosticsTracker } from "../openpond/provider-diagnostics.js";
import {
  deleteProviderCredential,
  parseProviderCredentialDeleteRequest,
  parseProviderCredentialWriteRequest,
  readProviderSecrets,
  updateProviderCredentialValidation,
  writeProviderChatGptSubscriptionCredential,
  writeProviderCredential,
} from "../openpond/provider-secrets.js";
import { providerSecretsConfigPath, providerSecretsKeyPath } from "../paths.js";
import type { SqliteStore } from "../store/store.js";
import type { ProvidersFile } from "../types.js";
import { event, now } from "../utils.js";
import { loadCodexHistorySessions } from "../codex-history.js";
import {
  applyCodexHistorySidebarPreferences,
  loadCodexHistorySidebarPreferences,
} from "../codex-history-sidebar-preferences.js";
import { createOpenPondCache } from "../openpond/server-openpond-cache.js";
import { sandboxRequestPayload } from "../openpond/sandboxes.js";
import {
  findLocalProject,
  inferLocalProjectOpenPondLinks,
  listLocalProjects,
  localProjectStateWorkspace,
  localProjectWorkspacePaths,
  updateLocalProjectAgentSetup,
} from "../workspace/local-projects.js";
import {
  previewLocalProjectSourceUpload,
} from "../workspace/local-project-source-upload.js";
import { createServerWorkspacePayloads } from "../workspace/server-workspace-payloads.js";
import { loadWorkspaceStateAtPath, runWorkspaceCommand } from "../workspace/workspaces.js";
import {
  hasObjectKey,
  assertCreateImproveBackgroundApproved,
  fetchCloudProjects,
  asRecord,
  nonEmptyRecord,
  asRecordArray,
  stringValue,
  internalRepoPathForLocalProject,
  uploadLocalProjectCloudSource,
  sandboxProjectRecordOrFallback,
  upsertInternalSandboxProject,
  cloudProjectFromSandboxRecord,
  cloudWorkItemTeamInput,
  createImproveMetadata,
  usageAttributionMetadata,
  linkCreateImproveRunToWorkItem,
  attachCreateImproveRunToWorkItem,
  latestCreateImproveRunFromTimeline,
  normalizeCloudWorkItem,
  normalizeRequiredCloudWorkItem,
  normalizeCloudWorkItemMessage,
  normalizeRequiredCloudWorkItemMessage,
  normalizeCloudWorkItemActivity,
  normalizeCloudWorkItemRuntimeSession,
  assertApplyableLocalWorkspace,
  countPatchFiles,
  latestRuntimeSessionSandboxId,
} from "./server-payload-helpers.js";
import { createCodexHistoryPayloads } from "./codex-history-payloads.js";
export { assertCreateImproveBackgroundApproved } from "./server-payload-helpers.js";
import { createProfilePayloads } from "./profile-payloads.js";
import {
  LOCAL_ADAPTER_PROVIDER_ID,
  listLocalAdapterProviderModels,
  withLocalAdapterProviderModels,
} from "../training/local-adapter-models.js";

export type ServerPayloads = ReturnType<typeof createServerPayloads>;

const CLOUD_PROJECT_CACHE_TYPE = "openpond.cloudProjects";
const BOOTSTRAP_EVENT_WINDOW_LIMIT = 500;
const BOOTSTRAP_DIAGNOSTIC_LIMIT = 50;
const BOOTSTRAP_CODEX_HISTORY_LIMIT = 50;

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
  refreshCodexStatus?: () => Promise<CodexStatus>;
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
    refreshCodexStatus,
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
  const openAiSubscriptionAuth = createOpenAiSubscriptionAuthService({
    saveCredential: async (credential) => {
      await writeProviderChatGptSubscriptionCredential({
        paths: providerSecretPaths,
        providerId: "openai",
        credential,
        timestamp: now(),
      });
      await updateProvidersFile(providersFilePath, (latest) =>
        mergeProviderConfigPatch({
          value: latest,
          providerId: "openai",
          patch: { enabled: true },
          updatedAt: now(),
        }),
      );
    },
  });
  const providerDiagnostics = new ProviderDiagnosticsTracker();
  let appPreferencesUpdateQueue: Promise<void> = Promise.resolve();
  const {
    codexHistorySessionsWithLiveStatus,
    codexHistoryThreadPayload,
    interruptCodexHistoryTurnPayload,
    patchCodexHistorySessionPayload,
    sendCodexHistoryTurnPayload,
  } = createCodexHistoryPayloads({ attachmentRootDir, store, version });

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
    const [providerState, secrets, localAdapterModels] = await Promise.all([
      loadProvidersFileWithCatalog({ refresh: input.refreshCatalog ?? true }),
      readProviderSecrets(providerSecretPaths),
      listLocalAdapterProviderModels(store),
    ]);
    return withLocalAdapterProviderModels(buildProviderSettings({
      file: providerState.file,
      secrets,
      account: input.account,
      codex: input.codex ?? getCodexStatus(),
      catalog: providerState.catalog,
    }), localAdapterModels);
  }

  async function updateAppPreferencesPayload(payload: unknown): Promise<{ preferences: AppPreferences }> {
    const input = UpdateAppPreferencesRequestSchema.parse(payload);
    const syncGoalStorageLocation = hasObjectKey(payload, "goalStorageLocation");
    let updatedPreferences: AppPreferences | null = null;
    const update = appPreferencesUpdateQueue.then(async () => {
      const current = await loadAppPreferences();
      const next = normalizeAppPreferences({ ...current, ...input });
      updatedPreferences = next;
      if (JSON.stringify(next) !== JSON.stringify(current)) {
        await store.setCacheEntry(APP_PREFERENCES_CACHE_TYPE, APP_PREFERENCES_CACHE_KEY, next);
      }
      if (syncGoalStorageLocation) {
        await saveGlobalConfig({ goalStorageLocation: next.goalStorageLocation });
      }
    });
    appPreferencesUpdateQueue = update.catch(() => undefined);
    await update;
    return { preferences: updatedPreferences ?? await loadAppPreferences() };
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
      const [openPond, providerState, secrets, localAdapterModels] = await Promise.all([
        loadOpenPondData({ force: false }),
        loadProvidersFileWithCatalog({ refresh: true }),
        readProviderSecrets(providerSecretPaths),
        listLocalAdapterProviderModels(store),
      ]);
      return withLocalAdapterProviderModels(buildProviderSettings({
        file: providerState.file,
        secrets,
        account: openPond.account,
        codex: getCodexStatus(),
        catalog: providerState.catalog,
      }), localAdapterModels);
    });
  }

  async function localProviderRuntimeState(): Promise<{
    file: ProvidersFile;
    secrets: Awaited<ReturnType<typeof readProviderSecrets>>;
    catalog: ProviderCatalog | null;
    settings: ProviderSettings;
  }> {
    const [file, secrets, localAdapterModels] = await Promise.all([
      loadProvidersFile(),
      readProviderSecrets(providerSecretPaths),
      listLocalAdapterProviderModels(store),
    ]);
    const catalog = cachedProviderCatalog(file);
    return {
      file,
      secrets,
      catalog,
      settings: withLocalAdapterProviderModels(buildProviderSettings({
        file,
        secrets,
        codex: getCodexStatus(),
        catalog,
      }), localAdapterModels),
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
    if (providerId === LOCAL_ADAPTER_PROVIDER_ID) {
      const request = parseProviderModelsRefreshRequest(payload);
      const providers = await providerSettingsPayload();
      return {
        ...listProviderModels(providers, providerId, {
          query: request.query,
          refresh: false,
          limit: 100,
        }),
        providers,
      };
    }
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

  async function startOpenAiSubscriptionAuthPayload(payload: unknown): Promise<unknown> {
    const input = payload && typeof payload === "object" ? (payload as Record<string, unknown>) : {};
    const method = input.method === "device" ? "device" : "browser";
    if (method === "device") {
      const result = await openAiSubscriptionAuth.startDeviceLogin();
      return {
        providerId: "openai",
        method,
        ...result,
      };
    }
    const result = await openAiSubscriptionAuth.startBrowserLogin();
    return {
      providerId: "openai",
      method,
      ...result,
    };
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

      if (providerId === "codex") {
        const codex = refreshCodexStatus ? await refreshCodexStatus() : getCodexStatus();
        const modelId =
          request.modelId ?? config.defaultModel ?? state.settings.modelCaches[providerId]?.models[0]?.id ?? null;
        const errors: string[] = [];
        if (!codex.available) {
          errors.push("Codex CLI was not found. Install Codex or set CODEX_BINARY to the Codex executable.");
        } else if (codex.authHealth !== "signed_in") {
          errors.push("Sign in with ChatGPT through Codex before using subscription-backed models.");
        }
        if (!modelId) errors.push("OpenAI Codex has no selected or cached model.");

        const providers = await providerSettingsPayload();
        return {
          providerId,
          ok: errors.length === 0,
          live: false,
          baseUrl: null,
          modelId,
          credential: providers.statuses[providerId]?.credential ?? status.credential,
          errors,
          providers,
        };
      }

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

  async function recordClientDiagnosticPayload(payload: unknown): Promise<{ diagnostic: RuntimeEvent }> {
    const input = RecordClientDiagnosticRequestSchema.parse(payload);
    const diagnostic = event({
      name: "diagnostic",
      source: "server",
      status: "failed",
      output: input.message,
      data: {
        kind: "client_error",
        surface: input.surface,
        stack: input.stack ?? null,
        context: input.context ?? {},
      },
    });
    await appendRuntimeEvent(diagnostic);
    return { diagnostic };
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

  async function skillSourceFilePayload(
    scope: "codex" | "profile",
    skillName: string,
    filePath: string,
  ) {
    if (scope === "codex") {
      return readCodexPersonalSkillFile(skillName, filePath);
    }
    const profile = await loadBootstrapProfile(false);
    const skill = profile.skills.find((candidate) => candidate.name === skillName);
    if (!skill) throw new Error(`Profile skill not found: ${skillName}`);
    const absoluteSkillPath = path.resolve(skill.sourcePath, skill.path);
    return readSkillSourceFile({
      skillName,
      scope,
      packageRoot: path.dirname(absoluteSkillPath),
      relativeFilePath: filePath,
    });
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
      codexPersonalSkills,
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
      loadCodexPersonalSkills(),
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
    const [sidebarAppPreferences, sidebarFileBookmarks] = await Promise.all([
      store.getSidebarAppPreferences(scope),
      listSidebarFileBookmarksForScope(scope),
    ]);
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
      codexPersonalSkills,
      codexHistorySessions: validBootstrapSessions(
        codexHistorySessionsWithLiveStatus(
          applyCodexHistorySidebarPreferences(codexHistorySessions, codexHistorySidebarPreferences),
        ),
      ),
      sidebarAppPreferences,
      sidebarFileBookmarks,
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

  async function recordPreflightTurnFailure(
    sessionId: string,
    payload: unknown,
  ): Promise<BootstrapPayload> {
    const input = RecordPreflightTurnFailureRequestSchema.parse(payload);
    const session = await store.getSession(sessionId);
    if (!session) throw new Error("Session not found");
    const turnId = `preflight_${randomUUID()}`;
    await store.updateSession(sessionId, (current) => ({
      ...current,
      status: "failed",
      updatedAt: now(),
    }));
    await appendRuntimeEvent(
      event({
        sessionId,
        turnId,
        name: "turn.started",
        source: "chat_action",
        appId: session.appId,
        status: "started",
        args: {
          prompt: input.prompt,
          preflight: {
            target: input.target,
          },
        },
      }),
    );
    await appendRuntimeEvent(
      event({
        sessionId,
        turnId,
        name: "turn.failed",
        source: "server",
        appId: session.appId,
        status: "failed",
        error: input.error,
        data: {
          preflight: {
            target: input.target,
          },
        },
      }),
    );
    return bootstrapPayload({ forceOpenPond: false });
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

  async function previewLocalProjectCloudSourcePayload(
    projectId: string,
    payload: unknown = {},
  ): Promise<{
    localProject: LocalProject;
    preview: {
      rootPath: string;
      headCommit: string | null;
      branch: string;
      targetProjectId: string | null;
      targetProjectName: string;
      fileCount: number;
      byteCount: number;
      skippedCount: number;
      initializedEmptyProject: boolean;
    };
  }> {
    const input = PreviewLocalProjectCloudSourceRequestSchema.parse(payload);
    const localProject = await findLocalProject(store, projectId);
    if (!localProject) throw new Error("Project workspace not found");

    const linkedProject = localProject.linkedSandboxProject ?? null;
    const branch =
      input.branch?.trim() ||
      linkedProject?.defaultBranch?.trim() ||
      "main";
    const targetProjectName =
      linkedProject?.projectName?.trim() ||
      localProject.name;
    const fallbackReadme = `# ${targetProjectName}\n\nUploaded from OpenPond Desktop.\n`;
    const preview = await previewLocalProjectSourceUpload(localProject);

    return {
      localProject,
      preview: {
        rootPath: preview.rootPath,
        headCommit: preview.headCommit,
        branch,
        targetProjectId: linkedProject?.projectId ?? null,
        targetProjectName,
        fileCount: preview.initializedEmptyProject ? 1 : preview.fileCount,
        byteCount: preview.initializedEmptyProject
          ? Buffer.byteLength(fallbackReadme, "utf8")
          : preview.byteCount,
        skippedCount: preview.skippedCount,
        initializedEmptyProject: preview.initializedEmptyProject,
      },
    };
  }

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
      headCommit: string | null;
      fileCount: number;
      byteCount: number;
      skippedCount: number;
      initializedEmptyProject: boolean;
      transport?: "git_head" | "snapshot" | "api_source_upload";
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
    const chatContext = input.chatSessionId
      ? {
          sessionId: input.chatSessionId,
          turnId: `cloud_source_upload_${randomUUID()}`,
          displayPrompt: input.displayPrompt?.trim() || `/sync-cloud ${localProject.name}`,
        }
      : null;
    if (chatContext) {
      await beginCloudSourceUploadChatOperation({
        branch,
        chatContext,
        localProject,
        projectName,
        teamId: input.teamId,
      });
    }

    try {
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

      const commitMessage = `Upload ${localProject.name} from OpenPond Desktop`;
      const uploadResult = await uploadLocalProjectCloudSource({
        localProject,
        targetProjectId,
        teamId: input.teamId,
        repoUrl,
        apiKey,
        branch,
        commitMessage,
        fallbackReadme,
      });
      const syncPayload = uploadResult.syncPayload;
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
          defaultBranch: project.defaultBranch ?? stringValue(repo.defaultBranch) ?? uploadResult.branch,
          lastUploadedCommit: uploadResult.headCommit,
          lastUploadTransport: uploadResult.transport,
          manifestPath: project.manifestPath,
          manifestHash: project.manifestHash,
          syncedAt: project.syncedAt ?? now(),
          linkedAt: linkedProject?.linkedAt ?? now(),
        },
      });
      const upload = {
        rootPath: uploadResult.rootPath,
        branch: uploadResult.branch,
        headCommit: uploadResult.headCommit,
        fileCount: uploadResult.fileCount,
        byteCount: uploadResult.byteCount,
        skippedCount: uploadResult.skippedCount,
        initializedEmptyProject: uploadResult.initializedEmptyProject,
        transport: uploadResult.transport,
      };
      if (chatContext) {
        await completeCloudSourceUploadChatOperation({
          chatContext,
          localProject,
          project,
          upload,
        });
      }
      return {
        project,
        localProject: updatedLocalProject,
        bootstrap: await bootstrapPayload({ forceOpenPond: true }),
        upload,
      };
    } catch (error) {
      if (chatContext) {
        await failCloudSourceUploadChatOperation({
          chatContext,
          error,
          localProject,
        });
      }
      throw error;
    }
  }

  type CloudSourceUploadChatContext = {
    displayPrompt: string;
    sessionId: string;
    turnId: string;
  };

  async function updateCloudSourceUploadChatSession(
    sessionId: string,
    patch: Partial<Session>,
  ): Promise<Session> {
    const updated = await store.updateSession(sessionId, (session) => ({
      ...session,
      ...patch,
      updatedAt: now(),
    }));
    if (!updated) throw new Error("Upload chat session not found.");
    return updated;
  }

  async function beginCloudSourceUploadChatOperation(input: {
    branch: string;
    chatContext: CloudSourceUploadChatContext;
    localProject: LocalProject;
    projectName: string;
    teamId: string;
  }): Promise<void> {
    const session = await updateCloudSourceUploadChatSession(input.chatContext.sessionId, {
      status: "active",
      title: `Sync ${input.localProject.name} to Cloud`,
    });
    await appendRuntimeEvent(
      event({
        sessionId: session.id,
        turnId: input.chatContext.turnId,
        name: "turn.started",
        source: "chat_action",
        appId: session.appId,
        args: {
          prompt: input.chatContext.displayPrompt,
          command: "/sync-cloud",
        },
      }),
    );
    await appendRuntimeEvent(
      event({
        sessionId: session.id,
        turnId: input.chatContext.turnId,
        name: "workspace_action",
        source: "chat_action",
        action: "upload_cloud_source",
        appId: session.appId,
        status: "started",
        output: `Uploading ${input.localProject.name} to OpenPond Git on ${input.branch}.`,
        args: {
          branch: input.branch,
          localProjectId: input.localProject.id,
          projectName: input.projectName,
          teamId: input.teamId,
        },
      }),
    );
  }

  async function completeCloudSourceUploadChatOperation(input: {
    chatContext: CloudSourceUploadChatContext;
    localProject: LocalProject;
    project: CloudProject;
    upload: {
      branch: string;
      byteCount: number;
      fileCount: number;
      headCommit: string | null;
      initializedEmptyProject: boolean;
      skippedCount: number;
      transport?: "git_head" | "snapshot" | "api_source_upload";
    };
  }): Promise<void> {
    const session = await updateCloudSourceUploadChatSession(input.chatContext.sessionId, {
      cloudProjectId: input.project.id,
      cloudTeamId: input.project.teamId,
      status: "idle",
    });
    await appendRuntimeEvent(
      event({
        sessionId: session.id,
        turnId: input.chatContext.turnId,
        name: "workspace_action_result",
        source: "chat_action",
        action: "upload_cloud_source",
        appId: session.appId,
        status: "completed",
        output: cloudSourceUploadSummary({
          branch: input.upload.branch,
          byteCount: input.upload.byteCount,
          cloudProjectId: input.project.id,
          fileCount: input.upload.fileCount,
          headCommit: input.upload.headCommit,
          skippedCount: input.upload.skippedCount,
        }),
        data: {
          cloudSourceUpload: true,
          localProject: {
            id: input.localProject.id,
            name: input.localProject.name,
            path: input.localProject.workspacePath,
          },
          cloudProject: {
            id: input.project.id,
            name: input.project.name,
            teamId: input.project.teamId,
            defaultBranch: input.project.defaultBranch,
          },
          upload: input.upload,
        },
      }),
    );
    await appendRuntimeEvent(
      event({
        sessionId: session.id,
        turnId: input.chatContext.turnId,
        name: "turn.completed",
        source: "chat_action",
        appId: session.appId,
        status: "completed",
      }),
    );
  }

  async function failCloudSourceUploadChatOperation(input: {
    chatContext: CloudSourceUploadChatContext;
    error: unknown;
    localProject: LocalProject;
  }): Promise<void> {
    const message = input.error instanceof Error ? input.error.message : String(input.error);
    const session = await updateCloudSourceUploadChatSession(input.chatContext.sessionId, {
      status: "failed",
    });
    await appendRuntimeEvent(
      event({
        sessionId: session.id,
        turnId: input.chatContext.turnId,
        name: "workspace_action_result",
        source: "chat_action",
        action: "upload_cloud_source",
        appId: session.appId,
        status: "failed",
        output: `Upload failed for ${input.localProject.name}.`,
        error: message,
      }),
    );
    await appendRuntimeEvent(
      event({
        sessionId: session.id,
        turnId: input.chatContext.turnId,
        name: "turn.failed",
        source: "chat_action",
        appId: session.appId,
        status: "failed",
        error: message,
      }),
    );
  }

  function cloudSourceUploadSummary(input: {
    branch: string;
    byteCount: number;
    cloudProjectId: string;
    fileCount: number;
    headCommit: string | null;
    skippedCount: number;
  }): string {
    const commit = input.headCommit ? `local ${input.headCommit.slice(0, 7)}` : "no local commit";
    return [
      `Uploaded ${input.fileCount} file${input.fileCount === 1 ? "" : "s"} to OpenPond Git.`,
      `${formatByteCount(input.byteCount)} · ${input.skippedCount} skipped · ${commit} · ${input.branch}`,
      `Cloud project ${input.cloudProjectId} is ready for Hybrid or Cloud workspace use.`,
    ].join("\n");
  }

  function formatByteCount(value: number): string {
    if (value < 1024) return `${value} B`;
    if (value < 1024 * 1024) return `${Math.round(value / 1024)} KB`;
    return `${(value / (1024 * 1024)).toFixed(1)} MB`;
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
    const latestCreateImproveRun =
      latestCreateImproveRunFromTimeline(workItem, messages, activity) ??
      workItem.createImproveRun ??
      null;
    const workItemWithCreateImproveRun = attachCreateImproveRunToWorkItem(
      workItem,
      latestCreateImproveRun,
    );
    return CloudWorkItemDetailSchema.parse({
      workItem: workItemWithCreateImproveRun,
      messages,
      activity,
      runtimeSessions: [],
      createImproveRun: latestCreateImproveRun,
    });
  }

  async function createCloudWorkItemPayload(payload: unknown): Promise<CloudWorkItemDetail> {
    const input = CreateCloudWorkItemRequestSchema.parse(payload);
    const {
      createImproveRun,
      localProjectId,
      localProjectName,
      localWorkspacePath,
      requestedExecutionTarget,
      usageAttribution,
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
            ...(requestedExecutionTarget ? { requestedExecutionTarget } : {}),
            ...(localProjectId ? { localProjectId } : {}),
            ...(localProjectName ? { localProjectName } : {}),
            ...(localWorkspacePath ? { localWorkspacePath } : {}),
            ...usageAttributionMetadata(usageAttribution ?? null),
            ...createImproveMetadata(createImproveRun ?? null),
          },
        },
      }),
    );
    const createdWorkItem = normalizeRequiredCloudWorkItem(response.workItem);
    const linkedCreateImproveRun = linkCreateImproveRunToWorkItem({
      workItem: createdWorkItem,
      run: createImproveRun ?? null,
    });
    if (linkedCreateImproveRun) {
      await sandboxRequestPayload({
        type: "work_item_message_create",
        workItemId: createdWorkItem.id,
        payload: {
          teamId: input.teamId,
          role: "system",
          body: "Create/Improve run linked to this work item.",
          metadata: {
            source: "openpond_app_cloud_create_improve_link",
            hidden: true,
            ...usageAttributionMetadata(usageAttribution ?? null),
            ...createImproveMetadata(linkedCreateImproveRun),
          },
        },
      });
    }
    const workItem = attachCreateImproveRunToWorkItem(
      createdWorkItem,
      linkedCreateImproveRun,
    );
    return CloudWorkItemDetailSchema.parse({
      workItem,
      messages: [],
      activity: [],
      runtimeSessions: [],
      createImproveRun: linkedCreateImproveRun,
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
    assertCreateImproveRunLinked({
      actionLabel: "Cloud work item Create/Improve metadata",
      run: input.createImproveRun ?? null,
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
            ...usageAttributionMetadata(input.usageAttribution ?? null),
            ...createImproveMetadata(input.createImproveRun ?? null),
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
      createImproveRun,
      usageAttribution,
      payload: requestPayload,
      ...backgroundInput
    } = input;
    assertCreateImproveRunLinked({
      actionLabel: "Create/Improve background work",
      run: createImproveRun ?? null,
    });
    assertCreateImproveBackgroundApproved({
      run: createImproveRun ?? null,
    });
    return sandboxRequestPayload({
      type: "work_item_handle_background",
      workItemId,
      payload: {
        ...backgroundInput,
        ...(usageAttribution ? { usageAttribution } : {}),
        branchPolicy: input.branchPolicy ?? { mode: "patch_only" },
        payload: {
          source: "openpond_app_cloud_thread",
          ...(requestPayload ?? {}),
          ...usageAttributionMetadata(usageAttribution ?? null),
          ...createImproveMetadata(createImproveRun ?? null),
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

  async function applyCloudWorkItemLocalPatchPayload(
    workItemId: string,
    payload: unknown,
  ): Promise<{
    workItem: CloudWorkItem;
    localProject: LocalProject;
    workspaceState: WorkspaceState;
    patch: {
      sandboxId: string;
      filename: string | null;
      bytes: number;
      applied: true;
      fileCount: number;
    };
  }> {
    const input = ApplyCloudWorkItemLocalPatchRequestSchema.parse(payload);
    const detail = await getCloudWorkItemPayload(workItemId, { teamId: input.teamId });
    const workItem = detail.workItem;
    if (workItem.teamId !== input.teamId) {
      throw new Error("Cloud work item does not belong to the requested team.");
    }
    const localProject = await linkedLocalProjectForCloudWorkItem(
      workItem,
      input.localProjectId ?? null,
    );
    const sandboxId =
      input.sandboxId?.trim() ||
      workItem.latestSandboxId ||
      latestRuntimeSessionSandboxId(detail) ||
      null;
    if (!sandboxId) {
      throw new Error("No reviewed Cloud sandbox is available for this work item.");
    }

    const workspaceOptions = {
      clone: false,
      allowPlainFolder: true,
      linkedSourceHeadCommit: localProject.linkedSandboxProject?.lastUploadedCommit ?? null,
    };
    const workspaceState = await loadWorkspaceStateAtPath(
      localProjectWorkspacePaths(localProject),
      localProjectStateWorkspace(localProject),
      workspaceOptions,
    );
    await assertApplyableLocalWorkspace(workspaceState);

    const patchResponse = asRecord(
      await sandboxRequestPayload({
        type: "git_export_patch",
        sandboxId,
        payload: {
          ...(input.baseRef ? { baseRef: input.baseRef } : {}),
        },
      }),
    );
    const patchRecord = nonEmptyRecord(patchResponse.patch) ?? patchResponse;
    if (patchRecord.isRepo === false) {
      throw new Error("Cloud sandbox is not a Git repository.");
    }
    const patchText = typeof patchRecord.patch === "string" ? patchRecord.patch : "";
    if (!patchText.trim() || patchRecord.empty === true) {
      throw new Error("Cloud patch is empty. There are no changes to apply locally.");
    }

    const check = await runWorkspaceCommand(
      "git",
      ["apply", "--check", "--whitespace=nowarn", "-"],
      workspaceState.repoPath,
      {},
      patchText,
    );
    if (check.code !== 0) {
      throw new Error(
        check.stderr.trim() ||
          check.stdout.trim() ||
          "Cloud patch does not apply cleanly to the local checkout.",
      );
    }
    const apply = await runWorkspaceCommand(
      "git",
      ["apply", "--whitespace=nowarn", "-"],
      workspaceState.repoPath,
      {},
      patchText,
    );
    if (apply.code !== 0) {
      throw new Error(
        apply.stderr.trim() ||
          apply.stdout.trim() ||
          "Unable to apply Cloud patch to the local checkout.",
      );
    }

    const nextWorkspaceState = await loadWorkspaceStateAtPath(
      localProjectWorkspacePaths(localProject),
      localProjectStateWorkspace(localProject),
      workspaceOptions,
    );
    return {
      workItem,
      localProject,
      workspaceState: nextWorkspaceState,
      patch: {
        sandboxId,
        filename: stringValue(patchRecord.filename),
        bytes:
          typeof patchRecord.bytes === "number"
            ? patchRecord.bytes
            : Buffer.byteLength(patchText, "utf8"),
        applied: true,
        fileCount: countPatchFiles(patchText),
      },
    };
  }

  async function linkedLocalProjectForCloudWorkItem(
    workItem: CloudWorkItem,
    localProjectId: string | null,
  ): Promise<LocalProject> {
    const projects = localProjectId
      ? [await findLocalProject(store, localProjectId)]
      : await listLocalProjects(store);
    const localProject = projects.find((project): project is LocalProject => {
      if (!project) return false;
      const linked = project.linkedSandboxProject;
      return linked?.teamId === workItem.teamId && linked.projectId === workItem.projectId;
    });
    if (!localProject) {
      throw new Error("No linked local checkout exists for this Cloud Project.");
    }
    return localProject;
  }

  async function currentSidebarScope(): Promise<string> {
    const context = await loadOpenPondAccountContext();
    return openPondCacheScope(context.accountState);
  }

  async function resolveSidebarFileAvailability(item: SidebarFileBookmark): Promise<boolean> {
    try {
      if (item.workspaceKind === "local") {
        await workspacePayloads.workspaceFilePayload(item.workspaceId, item.path);
      } else {
        await sandboxRequestPayload({
          type: "stat_file",
          sandboxId: item.workspaceId,
          payload: { path: item.path },
        });
      }
      return true;
    } catch {
      return false;
    }
  }

  async function listSidebarFileBookmarksForScope(scope: string): Promise<SidebarFileBookmark[]> {
    const items = await store.listSidebarFileBookmarks(scope);
    return Promise.all(items.map(async (item) => ({
      ...item,
      available: await resolveSidebarFileAvailability(item),
    })));
  }

  async function listSidebarFileBookmarksPayload(): Promise<SidebarFileBookmarksResponse> {
    return { items: await listSidebarFileBookmarksForScope(await currentSidebarScope()) };
  }

  async function patchSidebarFileBookmarkPayload(
    payload: unknown,
  ): Promise<SidebarFileBookmarksResponse> {
    const parsed = PatchSidebarFileBookmarkRequestSchema.parse(payload);
    const input: PatchSidebarFileBookmarkRequest = {
      ...parsed,
      path: normalizeSidebarFilePath(parsed.path),
    };
    const scope = await currentSidebarScope();
    await store.patchSidebarFileBookmark(scope, input);
    return { items: await listSidebarFileBookmarksForScope(scope) };
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

  async function updateOpenPondAccountConfigPayload(payload: unknown): Promise<BootstrapPayload> {
    const input = UpdateOpenPondAccountConfigRequestSchema.parse(payload);
    await updateOpenPondAccountConfig({
      handle: input.handle,
      currentBaseUrl: input.currentBaseUrl ?? undefined,
      baseUrl: input.baseUrl,
      apiBaseUrl: input.apiBaseUrl,
      chatApiBaseUrl: input.chatApiBaseUrl,
      environment: input.environment,
      setActive: input.setActive,
    });
    await appendRuntimeEvent(
      event({
        name: "diagnostic",
        source: "server",
        action: "openpond.account.config",
        status: "completed",
        output: `Updated OpenPond account config for ${input.handle}.`,
      })
    );
    return bootstrapPayload({ forceOpenPond: true });
  }

  const profilePayloads = createProfilePayloads({ appendRuntimeEvent });

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
    startOpenAiSubscriptionAuthPayload,
    validateProviderCredentialPayload,
    providerDiagnosticsPayload,
    recordClientDiagnosticPayload,
    updatePersonalizationPayload,
    bootstrapPayload,
    skillSourceFilePayload,
    findOpenPondApp,
    codexHistoryThreadPayload,
    patchCodexHistorySessionPayload,
    sendCodexHistoryTurnPayload,
    recordPreflightTurnFailure,
    interruptCodexHistoryTurnPayload,
    ...workspacePayloads,
    previewLocalProjectCloudSourcePayload,
    uploadLocalProjectCloudSourcePayload,
    listCloudWorkItemsPayload,
    getCloudWorkItemPayload,
    createCloudWorkItemPayload,
    sendCloudWorkItemMessagePayload,
    handleCloudWorkItemBackgroundPayload,
    cancelCloudWorkItemTaskPayload,
    openCloudWorkItemPayload,
    applyCloudWorkItemLocalPatchPayload,
    patchSidebarAppPreference,
    listSidebarFileBookmarksPayload,
    patchSidebarFileBookmarkPayload,
    reorderSidebarApps,
    refreshOpenPondPayload,
    loadMoreOpenPondAppsPayload,
    switchOpenPondPayload,
    saveOpenPondAccountPayload,
    updateOpenPondAccountConfigPayload,
    ...profilePayloads,
    waitForOpenPondRefresh,
  };
}
