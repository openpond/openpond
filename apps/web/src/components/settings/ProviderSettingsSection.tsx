import { AcpAgentBrowser } from "./AcpAgentBrowser";
import { apiFetch } from "../../api/api-client";
import { UrlModelConnections } from "./UrlModelConnections";
import { api } from "../../api";
import { navigateDesktopRoute } from "../labs/lab-primary-tab-state";
import { useAgentDialogFocus } from "../apps/useAgentDialogFocus";
import "../../styles/settings/provider-connections.css";
import type { ClientConnection } from "../../api/api-client";
import { useEffect, useId, useMemo, useRef, useState, type FormEvent, type ReactNode } from "react";
import {
  CheckCircle2,
  CircleAlert,
  KeyRound,
  Loader2,
  RefreshCw,
  Save,
  Trash2,
  X,
} from "../icons";
import type {
  BootstrapPayload,
  ChatProvider,
  ProviderConfigPatch,
  ProviderCredentialWriteRequest,
  ProviderSettings,
  ProviderStatus,
} from "@openpond/contracts";
import { isRegisteredAcpProvider, PROVIDER_IDS } from "@openpond/contracts";
import { DropdownSelect } from "../DropdownSelect";
import type { CheckNativeProvider } from "./native-provider-check";
import { DESKTOP_AGENT_PROVIDERS, isAcpProvider, NativeAgentProviderDetails } from "./NativeAgentProviderDetails";
import { ProviderPlanUsage } from "./ProviderPlanUsage";
import {
  chatModelLabel,
  isRunnableChatProvider,
  modelOptionsForProvider,
  type DropdownOption,
} from "../../lib/app-models";

type ProviderSettingsSectionProps = {
  onProvidersChanged: (providers: ProviderSettings) => void;
  checkNativeProvider: CheckNativeProvider;
  connection: ClientConnection | null;
  account: BootstrapPayload["account"] | null;
  codex: BootstrapPayload["codex"] | null;
  providers: ProviderSettings | null;
  providerBusy: string | null;
  validationMessage: string | null;
  deleteProviderCredential: (provider: ChatProvider) => Promise<void>;
  loadProviderModels: (provider: ChatProvider) => Promise<void>;
  refreshProviderModels: (provider: ChatProvider) => Promise<void>;
  saveProviderConfig: (provider: ChatProvider, patch: ProviderConfigPatch) => Promise<void>;
  saveProviderCredential: (
    provider: ChatProvider,
    credential: ProviderCredentialWriteRequest,
  ) => Promise<void>;
  startOpenAiSubscriptionAuth: (method: "browser" | "device") => Promise<unknown>;
  validateProvider: (provider: ChatProvider, request?: { baseUrl?: string; modelId?: string }) => Promise<void>;
};

const CREDENTIAL_SOURCE_OPTIONS: Array<DropdownOption & { value: ProviderCredentialWriteRequest["source"] }> = [
  { value: "local_secret", label: "Saved key", description: "Encrypted on this machine" },
  { value: "env", label: "Environment variable", description: "Read by the local server" },
];
const MAX_PROVIDER_MODEL_DATALIST_OPTIONS = 120;
const SUBSCRIPTION_PROVIDER_IDS = new Set<ChatProvider>(["openai", "xai", "zai"]);
const SUBSCRIPTION_CREDENTIAL_MODES = new Set(["chatgpt-subscription"]);
const ZAI_CODING_PLAN_BASE_URL = "https://api.z.ai/api/coding/paas/v4";
export type ProviderCredentialTab = "api" | "subscription";

function splitModelOverrides(value: string): string[] {
  return value
    .split(/[\n,]/)
    .map((item) => item.trim())
    .filter(Boolean);
}

function providerStateLabel(status: ProviderStatus | null | undefined): string {
  if (!status) return "Unknown";
  if (status.available) return "Ready";
  if (status.credential.connected) return "Configured";
  if (status.credential.lastError || status.lastError) return "Needs attention";
  if (status.id === "codex") return "Needs Codex login";
  if (isAcpProvider(status.id)) return "Check connection";
  if (status.routing.localByok) return "Needs key";
  return status.enabled ? "Enabled" : "Off";
}

function providerStateTone(status: ProviderStatus | null | undefined): string {
  if (!status) return "unknown";
  if (status.available) return "ready";
  if (status.credential.connected) return "configured";
  if (status.credential.lastError || status.lastError) return "warning";
  if (status.id === "codex") return "warning";
  return "muted";
}

function credentialSummary(status: ProviderStatus): string {
  if (!status.credential.connected) return status.credential.lastError ?? "Not connected";
  if (status.credential.redacted) return status.credential.redacted;
  if (status.credential.source === "native_agent_login") return "Native login";
  if (status.credential.source === "chatgpt_subscription") return "ChatGPT subscription";
  return status.credential.source;
}

function normalizeProviderBaseUrl(value: string | null | undefined): string {
  return value?.trim().replace(/\/+$/, "") ?? "";
}

function usesZaiCodingPlan(status: ProviderStatus, settings: ProviderSettings): boolean {
  return (
    status.id === "zai" &&
    normalizeProviderBaseUrl(settings.providers.zai?.baseUrl) === ZAI_CODING_PLAN_BASE_URL
  );
}

export function providerCredentialLabel(status: ProviderStatus, settings: ProviderSettings): string {
  if (!status.credential.connected || !status.routing.localByok) return "";
  if (status.credential.source === "native_agent_login") return "Native login";
  if (status.credential.source === "chatgpt_subscription") return "Subscription";
  if (usesZaiCodingPlan(status, settings)) return "Coding Plan key";
  return "API key";
}

function providerMeta(status: ProviderStatus, settings: ProviderSettings): string {
  const cache = settings.modelCaches[status.id];
  if (status.routing.localByok && status.enabled && !status.credential.connected) return "";
  if (!status.enabled && status.id !== "openpond") return "";
  const modelCount = Math.max(cache?.models.length ?? 0, status.modelIds.length);
  const modelLabel = status.defaultModel ? chatModelLabel(status.defaultModel, settings, status.id) : "";
  const modelCountLabel = modelCount === 1 ? "1 model" : `${modelCount} models`;
  const credentialLabel = providerCredentialLabel(status, settings);
  const parts = [
    credentialLabel,
    cache ? modelCountLabel : "",
    modelLabel,
  ].filter(Boolean);
  return parts.join(" · ");
}

function canToggleProvider(providerId: ChatProvider): boolean {
  return providerId !== "openpond" && isRunnableChatProvider(providerId);
}

export function providerSupportsSubscription(status: ProviderStatus | null | undefined): boolean {
  if (!status) return false;
  return (
    SUBSCRIPTION_PROVIDER_IDS.has(status.id) ||
    status.credentialModes.some((mode) => SUBSCRIPTION_CREDENTIAL_MODES.has(mode))
  );
}

export function providerCredentialTabs(status: ProviderStatus | null | undefined): ProviderCredentialTab[] {
  return providerSupportsSubscription(status) ? ["api", "subscription"] : ["api"];
}

export function defaultProviderCredentialTab(
  status: ProviderStatus | null | undefined,
  settings: ProviderSettings | null | undefined,
): ProviderCredentialTab {
  if (!status || !settings || !providerSupportsSubscription(status)) return "api";
  if (status.credential.source === "chatgpt_subscription") return "subscription";
  if (usesZaiCodingPlan(status, settings)) return "subscription";
  return "api";
}

export function providerRowsForSubscriptionFilter(
  settings: ProviderSettings | null | undefined,
  subscriptionsOnly: boolean,
): ChatProvider[] {
  const rows = PROVIDER_IDS.filter((providerId) => Boolean(settings?.statuses[providerId]));
  if (!subscriptionsOnly) return rows;
  return rows.filter((providerId) => providerSupportsSubscription(settings?.statuses[providerId]));
}

function formatDate(value: string | null | undefined): string {
  if (!value) return "Never";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleString();
}

export function visibleProviderModelOptions(
  options: DropdownOption[],
  pinnedModelIds: string[],
  limit = MAX_PROVIDER_MODEL_DATALIST_OPTIONS,
): DropdownOption[] {
  const visible: DropdownOption[] = [];
  const seen = new Set<string>();
  const pinned = new Set(pinnedModelIds.map((value) => value.trim()).filter(Boolean));
  const add = (option: DropdownOption) => {
    if (seen.has(option.value) || visible.length >= limit) return;
    seen.add(option.value);
    visible.push(option);
  };
  for (const option of options) {
    if (pinned.has(option.value)) add(option);
  }
  for (const option of options) add(option);
  return visible;
}

export function ProviderSettingsSection({
  onProvidersChanged,
  checkNativeProvider,
  connection,
  account,
  codex,
  providers,
  providerBusy,
  validationMessage,
  deleteProviderCredential,
  loadProviderModels,
  refreshProviderModels,
  saveProviderConfig,
  saveProviderCredential,
  startOpenAiSubscriptionAuth,
  validateProvider,
}: ProviderSettingsSectionProps) {
  const [removing, setRemoving] = useState<string | null>(null);
  const [removalError, setRemovalError] = useState<string | null>(null);
  const [detailsProviderId, setDetailsProviderId] = useState<ChatProvider | null>(null);
  const providerRows = [...DESKTOP_AGENT_PROVIDERS, ...(Object.keys(providers?.statuses ?? {}).filter(isRegisteredAcpProvider))].filter(id => providers?.statuses[id]);
  const detailsStatus = detailsProviderId ? providers?.statuses[detailsProviderId] ?? null : null;
  function openProviderDetails(providerId: ChatProvider, loadModels: boolean) {
    setDetailsProviderId(providerId);
    if (loadModels) void loadProviderModels(providerId);
  }

  return (
    <section className="account-settings provider-connections-settings">
      <div className="provider-connections-heading"><h1>Providers</h1><AcpAgentBrowser connection={connection} onChanged={onProvidersChanged} onAdded={id => setDetailsProviderId(id)} /></div>
      <div className="provider-connections-intro"><p>Manage your installed agents and login. Sync their conversations from Connections.</p><button type="button" className="settings-secondary" onClick={() => void navigateDesktopRoute({ kind: "view", view: "apps" })}>Connections & apps</button></div>

      {providers ? (
        <div className="provider-connections-panel">
          {providerRows.length > 0 ? (
            <div className="provider-connections-grid" role="list">
              {providerRows.map((providerId) => {
                const status = providers.statuses[providerId]!;
                const cache = providers.modelCaches[providerId];
                const needsModelLoad =
                  status.modelIds.length > 0 && (cache?.models.length ?? 0) < status.modelIds.length;
                const rowBusy = providerBusy?.startsWith(`${providerId}:`) ?? false;
                const toggleEnabled = canToggleProvider(providerId);
                const checked = providerId === "openpond" || Boolean(providers.providers[providerId]?.enabled);
                return (
                  <div className="provider-connection-card" role="listitem" key={providerId}>
                    <div className="provider-connection-identity"><strong>{status.displayName}</strong>
                    <label className="provider-toggle" aria-label={`Enable ${status.displayName}`}>
                      <input
                        type="checkbox"
                        checked={checked}
                        disabled={!toggleEnabled || rowBusy}
                        onChange={(event) => {
                          void saveProviderConfig(providerId, { enabled: event.currentTarget.checked });
                        }}
                      />
                      <span />
                    </label>
                    </div>
                    <div className={`provider-connection-status ${providerStateTone(status)}`}>
                      {rowBusy ? <Loader2 size={13} className="settings-spin" /> : null}
                      <span>{providerStateLabel(status)}</span>
                    </div>
                    <p>{providerMeta(status, providers) || (status.enabled ? "Check your installation and sign in to use this agent." : "Enable this agent to use it in chats.")}</p>
                    {providerId === "codex" || providerId === "claude-code" ? <ProviderPlanUsage connection={connection} provider={providerId} /> : null}
                    <button
                      type="button"
                      className="settings-secondary"
                      onClick={() => {
                        openProviderDetails(providerId, needsModelLoad);
                      }}
                    >
                      Manage
                    </button>
                    {isRegisteredAcpProvider(providerId) ? <button type="button" className="settings-secondary" disabled={removing !== null || !connection} onClick={async () => {
                      if (!connection) return; setRemoving(providerId); setRemovalError(null);
                      try { const result = await apiFetch<{ settings: ProviderSettings }>(connection, "/v1/providers/acp-registry", { method: "DELETE", body: JSON.stringify({ providerId }) }); onProvidersChanged(result.settings); if (detailsProviderId === providerId) setDetailsProviderId(null); }
                      catch (error) { setRemovalError(error instanceof Error ? error.message : "Could not remove ACP agent."); }
                      finally { setRemoving(null); }
                    }}>{removing === providerId ? "Removing…" : "Remove connection"}</button> : null}
                  </div>
                );
              })}
            </div>
          ) : (
            <div className="empty-account-list provider-manager-empty">
              <strong>No agent providers available</strong>
            </div>
          )}
        </div>
      ) : null}

      {removalError ? <p role="alert">{removalError}</p> : null}

      <UrlModelConnections connection={connection} onChanged={async () => { if (connection) onProvidersChanged(await api.providerSettings(connection)); }} />

      {validationMessage ? (
        <div className="settings-footnote provider-validation-message">
          <span>Last validation</span>
          <strong>{validationMessage}</strong>
        </div>
      ) : null}

      {detailsProviderId && detailsStatus && providers ? (
        <ProviderDetailsDialog
          checkNativeProvider={checkNativeProvider}
          connection={connection}
          account={account}
          codex={codex}
          providerId={detailsProviderId}
          providerBusy={providerBusy}
          settings={providers}
          status={detailsStatus}
          onClose={() => setDetailsProviderId(null)}
          onDeleteCredential={deleteProviderCredential}
          onRefreshModels={refreshProviderModels}
          onSaveConfig={saveProviderConfig}
          onSaveCredential={saveProviderCredential}
          onStartOpenAiSubscriptionAuth={startOpenAiSubscriptionAuth}
          onValidate={validateProvider}
        />
      ) : null}
    </section>
  );
}

export function ProviderDetailsDialog({
  checkNativeProvider,
  connection,
  account,
  codex,
  providerId,
  providerBusy,
  settings,
  status,
  onClose,
  onDeleteCredential,
  onRefreshModels,
  onSaveConfig,
  onSaveCredential,
  onStartOpenAiSubscriptionAuth,
  onValidate,
  conversationPanel,
}: {
  conversationPanel?: ReactNode;
  checkNativeProvider: CheckNativeProvider;
  connection: ClientConnection | null;
  account: BootstrapPayload["account"] | null;
  codex: BootstrapPayload["codex"] | null;
  providerId: ChatProvider;
  providerBusy: string | null;
  settings: ProviderSettings;
  status: ProviderStatus;
  onClose: () => void;
  onDeleteCredential: (provider: ChatProvider) => Promise<void>;
  onRefreshModels: (provider: ChatProvider) => Promise<void>;
  onSaveConfig: (provider: ChatProvider, patch: ProviderConfigPatch) => Promise<void>;
  onSaveCredential: (
    provider: ChatProvider,
    credential: ProviderCredentialWriteRequest,
  ) => Promise<void>;
  onStartOpenAiSubscriptionAuth: (method: "browser" | "device") => Promise<unknown>;
  onValidate: (provider: ChatProvider, request?: { baseUrl?: string; modelId?: string }) => Promise<void>;
}) {
  const dialogRef = useAgentDialogFocus(onClose);
  const [tab, setTab] = useState<"setup" | "sync">("setup");
  const agentTabsId = useId();
  const config = settings.providers[providerId];
  const cache = settings.modelCaches[providerId];
  const credentialTabsId = useId();
  const lastDialogProviderIdRef = useRef(providerId);
  const modelCount = Math.max(cache?.models.length ?? 0, status.modelIds.length);
  const localByok = status.routing.localByok && isRunnableChatProvider(providerId) && providerId !== "codex" && !isAcpProvider(providerId);
  const credentialTabs = useMemo(() => (localByok ? providerCredentialTabs(status) : []), [localByok, status]);
  const hasSubscriptionTab = credentialTabs.includes("subscription");
  const [credentialTab, setCredentialTab] =
    useState<ProviderCredentialTab>(() => defaultProviderCredentialTab(status, settings));
  const showingSubscriptionDetails = localByok && credentialTab === "subscription" && hasSubscriptionTab;
  const credentialPanelIdFor = (tab: ProviderCredentialTab) => `${credentialTabsId}-${tab}-panel`;
  const baseUrlLabel =
    providerId === "codex"
      ? "Codex app server"
      : config?.baseUrl ?? (providerId === "openpond" ? account?.chatApiBaseUrl : null) ?? "Not set";

  useEffect(() => {
    const providerChanged = lastDialogProviderIdRef.current !== providerId;
    if (providerChanged) {
      lastDialogProviderIdRef.current = providerId;
      setCredentialTab(defaultProviderCredentialTab(status, settings));
      return;
    }
    if (localByok && !credentialTabs.includes(credentialTab)) setCredentialTab("api");
  }, [credentialTab, credentialTabs, localByok, providerId, settings, status]);

  return (
    <div className="git-dialog-backdrop provider-dialog-backdrop" role="presentation" onMouseDown={onClose}>
      <section
        ref={dialogRef}
        className={`git-dialog provider-details-dialog${conversationPanel ? " agent-setup-dialog" : ""}`}
        role="dialog"
        aria-modal="true"
        aria-label={`${status.displayName} provider details`}
        onMouseDown={(event) => event.stopPropagation()}
      >
        <button className="git-dialog-close" type="button" title="Close" aria-label="Close" onClick={onClose}>
          <X size={16} />
        </button>
        <div className="provider-dialog-header">
          <div>
            <h2>{status.displayName}</h2>
            <span>{(DESKTOP_AGENT_PROVIDERS.includes(providerId) || isRegisteredAcpProvider(providerId)) ? "Installation and login" : "API and subscription settings"}</span>
          </div>
          <div className={`provider-state-pill ${providerStateTone(status)}`}>
            {providerStateLabel(status)}
          </div>
        </div>

        {(DESKTOP_AGENT_PROVIDERS.includes(providerId) || isRegisteredAcpProvider(providerId)) && config ? <label className="provider-chat-toggle"><span className="provider-toggle"><input type="checkbox" aria-label={`Enable ${status.displayName} for chat`} checked={config.enabled} disabled={providerBusy !== null} onChange={event => void onSaveConfig(providerId, { enabled: event.target.checked })} /><span aria-hidden="true" /></span><span>Use {status.displayName} for chats</span></label> : null}
        {conversationPanel ? <div className="surface-tabs provider-agent-tabs" role="tablist" aria-label="Agent settings" onKeyDown={event => {
          if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
          event.preventDefault();
          const next = tab === "setup" ? "sync" : "setup";
          setTab(next); event.currentTarget.querySelector<HTMLElement>(`#${CSS.escape(`${agentTabsId}-${next}`)}`)?.focus();
        }}><button type="button" role="tab" id={`${agentTabsId}-setup`} aria-controls={`${agentTabsId}-setup-panel`} aria-selected={tab === "setup"} tabIndex={tab === "setup" ? 0 : -1} onClick={() => setTab("setup")}>Agent setup</button><button type="button" role="tab" id={`${agentTabsId}-sync`} aria-controls={`${agentTabsId}-sync-panel`} aria-selected={tab === "sync"} tabIndex={tab === "sync" ? 0 : -1} onClick={() => setTab("sync")}>Conversation sync</button></div> : null}
        <div hidden={tab !== "setup"} id={`${agentTabsId}-setup-panel`} role={conversationPanel ? "tabpanel" : undefined} aria-labelledby={conversationPanel ? `${agentTabsId}-setup` : undefined}>
        {localByok ? (
          <div className="surface-tabs provider-mode-tabs" role="tablist" aria-label={`${status.displayName} mode`}>
            {credentialTabs.map((tab) => (
              <button
                type="button"
                role="tab"
                id={`${credentialTabsId}-${tab}`}
                key={tab}
                className={credentialTab === tab ? "active" : undefined}
                aria-selected={credentialTab === tab}
                aria-controls={credentialPanelIdFor(tab)}
                onClick={() => setCredentialTab(tab)}
              >
                {tab === "api" ? "API" : "Subscription"}
              </button>
            ))}
          </div>
        ) : null}

        {!(DESKTOP_AGENT_PROVIDERS.includes(providerId) || isRegisteredAcpProvider(providerId)) ? <dl className="provider-dialog-stats">
          <div>
            <dt>Credential</dt>
            <dd title={credentialSummary(status)}>{credentialSummary(status)}</dd>
          </div>
          {!showingSubscriptionDetails ? (
            <>
              {!isAcpProvider(providerId) ? <div>
                <dt>Base URL</dt>
                <dd title={baseUrlLabel}>{baseUrlLabel}</dd>
              </div> : null}
              <div>
                <dt>Model</dt>
                <dd title={config?.defaultModel ?? status.defaultModel ?? undefined}>
                  {config?.defaultModel ?? status.defaultModel ?? "Not set"}
                </dd>
              </div>
              <div>
                <dt>Models</dt>
                <dd title={cache?.lastError ?? undefined}>
                  {modelCount} cached, {formatDate(cache?.fetchedAt)}
                </dd>
              </div>
            </>
          ) : null}
          {providerId === "codex" ? (
            <>
              <div>
                <dt>Account</dt>
                <dd title={codex?.account?.email ?? undefined}>{codex?.account?.label ?? codex?.account?.email ?? "Not signed in"}</dd>
              </div>
              <div>
                <dt>Binary</dt>
                <dd title={codex?.binaryPath ?? undefined}>{codex?.binaryPath ?? "Not found"}</dd>
              </div>
            </>
          ) : null}
          {status.credential.lastError || cache?.lastError || status.lastError ? (
            <div className="provider-dialog-error">
              <dt>Error</dt>
              <dd title={status.credential.lastError ?? cache?.lastError ?? status.lastError ?? undefined}>
                {status.credential.lastError ?? cache?.lastError ?? status.lastError}
              </dd>
            </div>
          ) : null}
        </dl> : null}

        {providerId === "codex" ? (
          <>{config ? <NativeAgentProviderDetails connection={connection} key={providerId} providerId={providerId} config={config} status={status} cachedModels={cache?.models ?? []} busy={providerBusy !== null} onCheck={checkNativeProvider} /> : null}
          <div className="provider-dialog-body"><h3>ChatGPT with the OpenPond harness</h3><p>Native Codex and the OpenPond harness keep their own connections. Choose the execution path in the model picker.</p><p>{settings.statuses.openai?.credential.connected ? "OpenPond harness connected" : "OpenPond harness not connected"}</p><button type="button" className="settings-secondary" disabled={providerBusy !== null} onClick={() => void onStartOpenAiSubscriptionAuth("browser")}>Connect ChatGPT for OpenPond</button><button type="button" className="settings-secondary" disabled={providerBusy !== null} onClick={() => void onSaveConfig("openai", { enabled: !settings.providers.openai?.enabled })}>{settings.providers.openai?.enabled ? "Disable" : "Enable"} OpenPond harness route</button></div></>
        ) : isAcpProvider(providerId) && config ? (
          <NativeAgentProviderDetails connection={connection} key={providerId} providerId={providerId} config={config} status={status} cachedModels={cache?.models ?? []} busy={providerBusy !== null} onCheck={checkNativeProvider} />
        ) : localByok && config && cache ? (
          <LocalByokProviderDetails
            credentialTab={credentialTab}
            credentialTabsId={credentialTabsId}
            hasSubscriptionTab={hasSubscriptionTab}
            providerId={providerId}
            providerBusy={providerBusy}
            settings={settings}
            status={status}
            onDeleteCredential={onDeleteCredential}
            onRefreshModels={onRefreshModels}
            onSaveConfig={onSaveConfig}
            onSaveCredential={onSaveCredential}
            onStartOpenAiSubscriptionAuth={onStartOpenAiSubscriptionAuth}
            onValidate={onValidate}
          />
        ) : status.routing.localByok && !isRunnableChatProvider(providerId) ? (
          <div className="provider-dialog-note">
            <CircleAlert size={15} />
            <span>Adapter pending</span>
          </div>
        ) : null}
        </div>
        {tab === "sync" ? <div role="tabpanel" id={`${agentTabsId}-sync-panel`} aria-labelledby={`${agentTabsId}-sync`}>{conversationPanel}</div> : null}
      </section>
    </div>
  );
}

function LocalByokProviderDetails({
  credentialTab,
  credentialTabsId,
  hasSubscriptionTab,
  providerId,
  providerBusy,
  settings,
  status,
  onDeleteCredential,
  onRefreshModels,
  onSaveConfig,
  onSaveCredential,
  onStartOpenAiSubscriptionAuth,
  onValidate,
}: {
  credentialTab: ProviderCredentialTab;
  credentialTabsId: string;
  hasSubscriptionTab: boolean;
  providerId: ChatProvider;
  providerBusy: string | null;
  settings: ProviderSettings;
  status: ProviderStatus;
  onDeleteCredential: (provider: ChatProvider) => Promise<void>;
  onRefreshModels: (provider: ChatProvider) => Promise<void>;
  onSaveConfig: (provider: ChatProvider, patch: ProviderConfigPatch) => Promise<void>;
  onSaveCredential: (
    provider: ChatProvider,
    credential: ProviderCredentialWriteRequest,
  ) => Promise<void>;
  onStartOpenAiSubscriptionAuth: (method: "browser" | "device") => Promise<unknown>;
  onValidate: (provider: ChatProvider, request?: { baseUrl?: string; modelId?: string }) => Promise<void>;
}) {
  const config = settings.providers[providerId]!;
  const modelOptions = useMemo(() => modelOptionsForProvider(providerId, settings), [providerId, settings]);
  const modelListId = `provider-models-${providerId}`;
  const lastProviderIdRef = useRef(providerId);
  const [baseUrl, setBaseUrl] = useState(config.baseUrl ?? "");
  const [defaultModel, setDefaultModel] = useState(config.defaultModel ?? "");
  const [modelOverrides, setModelOverrides] = useState(config.modelOverrides.join("\n"));
  const [dirtyConfigFields, setDirtyConfigFields] = useState({
    baseUrl: false,
    defaultModel: false,
    modelOverrides: false,
  });
  const [credentialSource, setCredentialSource] =
    useState<ProviderCredentialWriteRequest["source"]>("local_secret");
  const [credentialValue, setCredentialValue] = useState("");
  const [envVar, setEnvVar] = useState("");
  const configBusy = providerBusy === `${providerId}:config`;
  const credentialBusy = providerBusy === `${providerId}:credential`;
  const validateBusy = providerBusy === `${providerId}:validate`;
  const modelsBusy = providerBusy === `${providerId}:models`;
  const subscriptionBusy = providerBusy === "openai:credential";
  const openAiProvider = providerId === "openai";
  const xAiProvider = providerId === "xai";
  const zAiProvider = providerId === "zai";
  const credentialPanelIdFor = (tab: ProviderCredentialTab) => `${credentialTabsId}-${tab}-panel`;
  const credentialPanelId = credentialPanelIdFor(credentialTab);
  const showingSubscriptionDetails = credentialTab === "subscription" && hasSubscriptionTab;
  const keyCredentialMode = credentialTab === "subscription" && zAiProvider ? "coding-plan" : "api";
  const keyCredentialLabel = keyCredentialMode === "coding-plan" ? "Coding Plan key" : "API key";
  const keyCredentialPlaceholder =
    status.credential.connected
      ? keyCredentialMode === "coding-plan"
        ? "Replace saved plan key"
        : "Replace saved key"
      : keyCredentialLabel;
  const saveKeyLabel = keyCredentialMode === "coding-plan" ? "Save plan key" : "Save key";
  const visibleModelOptions = useMemo(
    () =>
      visibleProviderModelOptions(
        modelOptions,
        [defaultModel, ...splitModelOverrides(modelOverrides)],
      ),
    [defaultModel, modelOptions, modelOverrides],
  );
  const hiddenModelOptionCount = Math.max(0, modelOptions.length - visibleModelOptions.length);

  useEffect(() => {
    const providerChanged = lastProviderIdRef.current !== providerId;
    if (providerChanged) {
      lastProviderIdRef.current = providerId;
      setDirtyConfigFields({ baseUrl: false, defaultModel: false, modelOverrides: false });
      setBaseUrl(config.baseUrl ?? "");
      setDefaultModel(config.defaultModel ?? "");
      setModelOverrides(config.modelOverrides.join("\n"));
      return;
    }
    if (!dirtyConfigFields.baseUrl) setBaseUrl(config.baseUrl ?? "");
    if (!dirtyConfigFields.defaultModel) setDefaultModel(config.defaultModel ?? "");
    if (!dirtyConfigFields.modelOverrides) setModelOverrides(config.modelOverrides.join("\n"));
  }, [
    config.baseUrl,
    config.defaultModel,
    config.modelOverrides,
    dirtyConfigFields.baseUrl,
    dirtyConfigFields.defaultModel,
    dirtyConfigFields.modelOverrides,
    providerId,
  ]);

  const credentialReady =
    credentialSource === "env" ? Boolean(envVar.trim()) : Boolean(credentialValue.trim());

  async function submitConfig(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    await onSaveConfig(providerId, {
      enabled: true,
      baseUrl: baseUrl.trim() || null,
      defaultModel: defaultModel.trim() || null,
      modelOverrides: splitModelOverrides(modelOverrides),
    });
    setDirtyConfigFields({ baseUrl: false, defaultModel: false, modelOverrides: false });
  }

  async function submitCredential(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!credentialReady) return;
    if (credentialSource === "env") {
      await onSaveCredential(providerId, {
        source: "env",
        envVar: envVar.trim(),
      });
      return;
    }
    await onSaveCredential(providerId, {
      source: "local_secret",
      value: credentialValue,
    });
    setCredentialValue("");
  }

  function renderKeyCredentialForm({ panel = true }: { panel?: boolean } = {}) {
    return (
      <form
        className="provider-credential-panel"
        id={panel ? credentialPanelId : undefined}
        role={panel ? "tabpanel" : undefined}
        aria-labelledby={panel ? `${credentialTabsId}-${credentialTab}` : undefined}
        onSubmit={(event) => void submitCredential(event)}
      >
        <div className="provider-card-grid credential-grid">
          <div className="settings-select-field">
            <span>Credential source</span>
            <DropdownSelect
              value={credentialSource}
              disabled={credentialBusy}
              label="Credential source"
              options={CREDENTIAL_SOURCE_OPTIONS}
              onChange={(value) => setCredentialSource(value as ProviderCredentialWriteRequest["source"])}
            />
          </div>
          {credentialSource === "env" ? (
            <label className="settings-select-field">
              <span>Environment variable</span>
              <input
                value={envVar}
                disabled={credentialBusy}
                placeholder="PROVIDER_API_KEY"
                onChange={(event) => setEnvVar(event.currentTarget.value)}
              />
            </label>
          ) : (
            <label className="settings-select-field">
              <span>{keyCredentialLabel}</span>
              <input
                type="password"
                value={credentialValue}
                disabled={credentialBusy}
                placeholder={keyCredentialPlaceholder}
                autoComplete="off"
                onChange={(event) => setCredentialValue(event.currentTarget.value)}
              />
            </label>
          )}
        </div>
        <div className="settings-button-row">
          <button className="settings-secondary" disabled={credentialBusy || !credentialReady}>
            {credentialBusy ? <Loader2 size={14} className="settings-spin" /> : <KeyRound size={14} />}
            <span>{credentialBusy ? "Saving" : saveKeyLabel}</span>
          </button>
          <button
            type="button"
            className="settings-icon-button ghost"
            aria-label={`Delete ${status.displayName} credential`}
            disabled={credentialBusy || !status.credential.connected}
            onClick={() => void onDeleteCredential(providerId)}
          >
            <Trash2 size={15} />
          </button>
        </div>
      </form>
    );
  }

  function renderSubscriptionPanel() {
    if (openAiProvider) {
      return (
        <div
          className="provider-subscription-panel"
          id={credentialPanelId}
          role="tabpanel"
          aria-labelledby={`${credentialTabsId}-subscription`}
        >
          <div className="provider-dialog-note codex-provider-note">
            <KeyRound size={15} />
            <span>
              ChatGPT subscription auth opens OpenAI login and stores a refresh token locally. API keys remain available
              under the API tab for raw Platform billing.
            </span>
          </div>
          <div className="settings-button-row">
            <button
              type="button"
              className="settings-secondary"
              disabled={subscriptionBusy}
              onClick={() => void onStartOpenAiSubscriptionAuth("browser")}
            >
              {subscriptionBusy ? <Loader2 size={14} className="settings-spin" /> : <KeyRound size={14} />}
              <span>{subscriptionBusy ? "Opening" : "Connect ChatGPT"}</span>
            </button>
            <button
              type="button"
              className="settings-secondary"
              disabled={subscriptionBusy}
              onClick={() => void onStartOpenAiSubscriptionAuth("device")}
            >
              {subscriptionBusy ? <Loader2 size={14} className="settings-spin" /> : <KeyRound size={14} />}
              <span>Device code</span>
            </button>
            <button
              type="button"
              className="settings-icon-button ghost"
              aria-label={`Delete ${status.displayName} credential`}
              disabled={subscriptionBusy || !status.credential.connected}
              onClick={() => void onDeleteCredential(providerId)}
            >
              <Trash2 size={15} />
            </button>
          </div>
        </div>
      );
    }
    if (xAiProvider) {
      return (
        <div
          className="provider-subscription-panel"
          id={credentialPanelId}
          role="tabpanel"
          aria-labelledby={`${credentialTabsId}-subscription`}
        >
          <div className="provider-dialog-note xai-provider-note">
            <KeyRound size={15} />
            <span>
              SuperGrok includes Grok app and Grok Build access. xAI API calls here still use an xAI Console API key
              with API credits or invoiced billing, so there is no separate Connect SuperGrok step yet.
            </span>
          </div>
        </div>
      );
    }
    if (zAiProvider) {
      return (
        <div
          className="provider-subscription-panel"
          id={credentialPanelId}
          role="tabpanel"
          aria-labelledby={`${credentialTabsId}-subscription`}
        >
          <div className="provider-dialog-note subscription-provider-note">
            <KeyRound size={15} />
            <span>
              GLM Coding Plan uses a plan API key with the dedicated Coding endpoint. General Z.ai API keys and balances
              are separate.
            </span>
          </div>
          {renderKeyCredentialForm({ panel: false })}
        </div>
      );
    }
    return null;
  }

  return (
    <div className="provider-dialog-body">
      {!showingSubscriptionDetails ? (
        <form className="provider-card-form" onSubmit={(event) => void submitConfig(event)}>
          <div className="provider-card-grid">
            <label className="settings-select-field">
              <span>Base URL</span>
              <input
                value={baseUrl}
                disabled={configBusy}
                placeholder="https://api.example.com/v1"
                onChange={(event) => {
                  setDirtyConfigFields((current) => ({ ...current, baseUrl: true }));
                  setBaseUrl(event.currentTarget.value);
                }}
              />
            </label>
            <label className="settings-select-field">
              <span>Default model</span>
              <input
                list={modelListId}
                value={defaultModel}
                disabled={configBusy}
                placeholder="Model id"
                onChange={(event) => {
                  setDirtyConfigFields((current) => ({ ...current, defaultModel: true }));
                  setDefaultModel(event.currentTarget.value);
                }}
              />
              <datalist id={modelListId}>
                {visibleModelOptions.map((option) => (
                  <option key={option.value} value={option.value}>
                    {option.label}
                  </option>
                ))}
              </datalist>
              {hiddenModelOptionCount > 0 ? (
                <small>{hiddenModelOptionCount} more cached models hidden from suggestions</small>
              ) : null}
            </label>
          </div>
          <div className="settings-button-row">
            <button className="settings-secondary" disabled={configBusy}>
              {configBusy ? <Loader2 size={14} className="settings-spin" /> : <Save size={14} />}
              <span>{configBusy ? "Saving" : "Save config"}</span>
            </button>
            <button
              type="button"
              className="settings-secondary"
              disabled={modelsBusy}
              onClick={() => void onRefreshModels(providerId)}
            >
              {modelsBusy ? <Loader2 size={14} className="settings-spin" /> : <RefreshCw size={14} />}
              <span>{modelsBusy ? "Refreshing" : "Refresh models"}</span>
            </button>
            <button
              type="button"
              className="settings-secondary"
              disabled={validateBusy || !defaultModel.trim()}
              onClick={() =>
                void onValidate(providerId, {
                  baseUrl: baseUrl.trim() || undefined,
                  modelId: defaultModel.trim() || undefined,
                })
              }
            >
              {validateBusy ? <Loader2 size={14} className="settings-spin" /> : <CheckCircle2 size={14} />}
              <span>{validateBusy ? "Testing" : "Test"}</span>
            </button>
          </div>
        </form>
      ) : null}

      <div className="provider-card-form credential-form">
        {showingSubscriptionDetails ? renderSubscriptionPanel() : renderKeyCredentialForm()}
      </div>
    </div>
  );
}
