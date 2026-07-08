import { useEffect, useMemo, useRef, useState, type FormEvent } from "react";
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
import { PROVIDER_IDS } from "@openpond/contracts";
import { DropdownSelect } from "../DropdownSelect";
import {
  chatModelLabel,
  chatProviderLabel,
  isRunnableChatProvider,
  modelOptionsForProvider,
  type DropdownOption,
} from "../../lib/app-models";

type ProviderSettingsSectionProps = {
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
const SUBSCRIPTION_CREDENTIAL_MODES = new Set(["chatgpt-subscription"]);

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
  if (status.credential.source === "chatgpt_subscription") return "ChatGPT subscription";
  return status.credential.source;
}

function providerMeta(status: ProviderStatus, settings: ProviderSettings): string {
  const cache = settings.modelCaches[status.id];
  if (status.routing.localByok && status.enabled && !status.credential.connected) return "";
  if (!status.enabled && status.id !== "openpond") return "";
  const modelCount = Math.max(cache?.models.length ?? 0, status.modelIds.length);
  const modelLabel = status.defaultModel ? chatModelLabel(status.defaultModel, settings, status.id) : "";
  const modelCountLabel = modelCount === 1 ? "1 model" : `${modelCount} models`;
  const credentialLabel =
    status.credential.connected && status.routing.localByok
      ? status.credential.source === "chatgpt_subscription"
        ? "Subscription"
        : "API key"
      : "";
  const parts = [
    providerStateLabel(status),
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
  return Boolean(status?.credentialModes.some((mode) => SUBSCRIPTION_CREDENTIAL_MODES.has(mode)));
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
  const [detailsProviderId, setDetailsProviderId] = useState<ChatProvider | null>(null);
  const [showSubscriptionProvidersOnly, setShowSubscriptionProvidersOnly] = useState(false);
  const allProviderRows = useMemo(
    () => providerRowsForSubscriptionFilter(providers, false),
    [providers],
  );
  const providerRows = useMemo(
    () => providerRowsForSubscriptionFilter(providers, showSubscriptionProvidersOnly),
    [providers, showSubscriptionProvidersOnly],
  );
  const subscriptionProviderCount = useMemo(
    () => allProviderRows.filter((providerId) => providerSupportsSubscription(providers?.statuses[providerId])).length,
    [allProviderRows, providers],
  );
  const subscriptionProviderCountLabel =
    subscriptionProviderCount === 1
      ? "1 provider supports subscription credentials"
      : `${subscriptionProviderCount} providers support subscription credentials`;
  const detailsStatus = detailsProviderId ? providers?.statuses[detailsProviderId] ?? null : null;
  function openProviderDetails(providerId: ChatProvider, loadModels: boolean) {
    setDetailsProviderId(providerId);
    if (loadModels) void loadProviderModels(providerId);
  }

  return (
    <section className="account-settings">
      <h1>Providers</h1>

      {providers ? (
        <div className="provider-manager-panel">
          <div className="account-list-heading">
            <span>Model providers</span>
            <small>{providerRows.length} of {allProviderRows.length} presets</small>
          </div>
          <label className="settings-check-row compact provider-subscription-filter">
            <input
              type="checkbox"
              checked={showSubscriptionProvidersOnly}
              onChange={(event) => setShowSubscriptionProvidersOnly(event.currentTarget.checked)}
            />
            <span>
              <strong>Subscriptions only</strong>
              <small>{subscriptionProviderCountLabel}</small>
            </span>
          </label>
          {providerRows.length > 0 ? (
            <div className="provider-manager-scroll" role="list">
              {providerRows.map((providerId) => {
                const status = providers.statuses[providerId]!;
                const cache = providers.modelCaches[providerId];
                const needsModelLoad =
                  status.modelIds.length > 0 && (cache?.models.length ?? 0) < status.modelIds.length;
                const rowBusy = providerBusy?.startsWith(`${providerId}:`) ?? false;
                const toggleEnabled = canToggleProvider(providerId);
                const checked = providerId === "openpond" || Boolean(providers.providers[providerId]?.enabled);
                return (
                  <div className="provider-manager-row" role="listitem" key={providerId}>
                    <label className="provider-toggle" aria-label={`Enable ${status.displayName}`}>
                      <input
                        type="checkbox"
                        checked={checked}
                        disabled={!toggleEnabled || rowBusy}
                        onChange={(event) => {
                          openProviderDetails(providerId, false);
                          void saveProviderConfig(providerId, { enabled: event.currentTarget.checked });
                        }}
                      />
                      <span />
                    </label>
                    <div className="provider-row-main">
                      <strong>{status.displayName}</strong>
                    </div>
                    <div className={`provider-row-status ${providerStateTone(status)}`}>
                      {rowBusy ? <Loader2 size={13} className="settings-spin" /> : null}
                      <span>{providerMeta(status, providers)}</span>
                    </div>
                    <button
                      type="button"
                      className="settings-secondary provider-details-button"
                      onClick={() => {
                        openProviderDetails(providerId, needsModelLoad);
                      }}
                    >
                      Details
                    </button>
                  </div>
                );
              })}
            </div>
          ) : (
            <div className="empty-account-list provider-manager-empty">
              <strong>No subscription providers</strong>
              <span>Turn off the filter to show API-key providers.</span>
            </div>
          )}
        </div>
      ) : null}

      {validationMessage ? (
        <div className="settings-footnote provider-validation-message">
          <span>Last validation</span>
          <strong>{validationMessage}</strong>
        </div>
      ) : null}

      {detailsProviderId && detailsStatus && providers ? (
        <ProviderDetailsDialog
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

function ProviderDetailsDialog({
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
}: {
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
  const config = settings.providers[providerId];
  const cache = settings.modelCaches[providerId];
  const modelCount = Math.max(cache?.models.length ?? 0, status.modelIds.length);
  const localByok = status.routing.localByok && isRunnableChatProvider(providerId) && providerId !== "codex";
  const baseUrlLabel =
    providerId === "codex"
      ? "Codex app server"
      : config?.baseUrl ?? (providerId === "openpond" ? account?.chatApiBaseUrl : null) ?? "Not set";
  return (
    <div className="git-dialog-backdrop provider-dialog-backdrop" role="presentation" onMouseDown={onClose}>
      <section
        className="git-dialog provider-details-dialog"
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
            <span>{chatProviderLabel(providerId, settings)}</span>
          </div>
          <div className={`provider-state-pill ${providerStateTone(status)}`}>
            {providerStateLabel(status)}
          </div>
        </div>

        <dl className="provider-dialog-stats">
          <div>
            <dt>Credential</dt>
            <dd title={credentialSummary(status)}>{credentialSummary(status)}</dd>
          </div>
          <div>
            <dt>Base URL</dt>
            <dd title={baseUrlLabel}>{baseUrlLabel}</dd>
          </div>
          <div>
            <dt>Model</dt>
            <dd title={config?.defaultModel ?? status.defaultModel ?? undefined}>
              {config?.defaultModel ?? status.defaultModel ?? "Not set"}
            </dd>
          </div>
          <div>
            <dt>Models</dt>
            <dd title={cache?.lastError ?? undefined}>
              {modelCount} cached · {formatDate(cache?.fetchedAt)}
            </dd>
          </div>
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
        </dl>

        {providerId === "codex" ? (
          <CodexProviderDetails
            providerBusy={providerBusy}
            status={status}
            onValidate={onValidate}
          />
        ) : localByok && config && cache ? (
          <LocalByokProviderDetails
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
      </section>
    </div>
  );
}

function CodexProviderDetails({
  providerBusy,
  status,
  onValidate,
}: {
  providerBusy: string | null;
  status: ProviderStatus;
  onValidate: (provider: ChatProvider, request?: { baseUrl?: string; modelId?: string }) => Promise<void>;
}) {
  const validateBusy = providerBusy === "codex:validate";
  return (
    <div className="provider-dialog-body codex-provider-body">
      <div className="provider-dialog-note codex-provider-note">
        <KeyRound size={15} />
        <span>
          Uses your local <code>codex login</code> session through the Codex app server. This route is separate from
          OpenAI Platform API-key billing.
        </span>
      </div>
      <div className="settings-button-row codex-provider-actions">
        <button
          type="button"
          className="settings-secondary"
          disabled={validateBusy}
          onClick={() => void onValidate("codex", { modelId: status.defaultModel ?? undefined })}
        >
          {validateBusy ? <Loader2 size={14} className="settings-spin" /> : <CheckCircle2 size={14} />}
          <span>{validateBusy ? "Testing" : "Test Codex login"}</span>
        </button>
      </div>
    </div>
  );
}

function LocalByokProviderDetails({
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

  return (
    <div className="provider-dialog-body">
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
        <label className="settings-select-field provider-model-overrides">
          <span>Manual models</span>
          <textarea
            value={modelOverrides}
            disabled={configBusy}
            placeholder="One model id per line"
            onChange={(event) => {
              setDirtyConfigFields((current) => ({ ...current, modelOverrides: true }));
              setModelOverrides(event.currentTarget.value);
            }}
          />
        </label>
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

      <form className="provider-card-form credential-form" onSubmit={(event) => void submitCredential(event)}>
        {openAiProvider ? (
          <div className="provider-dialog-note codex-provider-note">
            <KeyRound size={15} />
            <span>
              ChatGPT subscription auth opens OpenAI login and stores a refresh token locally. API keys remain available
              below for raw Platform billing.
            </span>
          </div>
        ) : null}
        {xAiProvider ? (
          <div className="provider-dialog-note xai-provider-note">
            <KeyRound size={15} />
            <span>
              xAI API access uses an API key with API credits or invoiced billing. Grok app subscriptions do not
              authenticate API requests here.
            </span>
          </div>
        ) : null}
        {openAiProvider ? (
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
          </div>
        ) : null}
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
              <span>API key</span>
              <input
                type="password"
                value={credentialValue}
                disabled={credentialBusy}
                placeholder={status.credential.connected ? "Replace saved key" : "API key"}
                autoComplete="off"
                onChange={(event) => setCredentialValue(event.currentTarget.value)}
              />
            </label>
          )}
        </div>
        <div className="settings-button-row">
          <button className="settings-secondary" disabled={credentialBusy || !credentialReady}>
            {credentialBusy ? <Loader2 size={14} className="settings-spin" /> : <KeyRound size={14} />}
            <span>{credentialBusy ? "Saving" : "Save key"}</span>
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
    </div>
  );
}
