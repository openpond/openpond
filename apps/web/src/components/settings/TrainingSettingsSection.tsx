import { useEffect, useMemo, useState, type FormEvent } from "react";
import type { AppPreferences, ChatModelRef, ProviderSettings } from "@openpond/contracts";
import { api, type ClientConnection, type PreferencesPayload } from "../../api";
import {
  chatModelLabel,
  chatProviderLabel,
  modelOptionsForProvider,
  providerModelSupportsReasoning,
  providerOptionsFromSettings,
} from "../../lib/app-models";

const DEFAULT_AUTHORING_MODEL = "default";

export function TrainingSettingsSection({
  connection,
  embedded = false,
  onError,
  onPreferences,
  preferences,
  providers,
}: {
  connection: ClientConnection | null;
  embedded?: boolean;
  onError: (message: string | null) => void;
  onPreferences: (payload: PreferencesPayload) => void;
  preferences: AppPreferences;
  providers: ProviderSettings | null | undefined;
}) {
  const training = preferences.training;
  const [authoringModel, setAuthoringModel] = useState(modelRefValue(training.defaultModelRef));
  const [creationMode, setCreationMode] = useState(training.creationMode);
  const [autoApproveEvidence, setAutoApproveEvidence] = useState(training.autoApproveEvidence);
  const [saving, setSaving] = useState(false);
  const providerOptions = useMemo(
    () => providerOptionsFromSettings(providers, { includeUnavailable: true }),
    [providers],
  );
  const authoringModelGroups = useMemo(
    () => providerOptions.map((provider) => ({
      provider,
      models: modelOptionsForProvider(provider.value, providers),
    })).filter((group) => group.models.length > 0),
    [providerOptions, providers],
  );
  const nextModelRef = modelRefFromValue(authoringModel);
  const defaultReasoning = providerModelSupportsReasoning(
    preferences.defaultChatProvider,
    preferences.defaultChatModel,
    providers,
  ) ? ` · ${titleCase(preferences.codexReasoningEffort)} reasoning` : "";
  const unchanged =
    modelRefsEqual(nextModelRef, training.defaultModelRef ?? null) &&
    creationMode === training.creationMode &&
    autoApproveEvidence === training.autoApproveEvidence;

  useEffect(() => {
    setAuthoringModel(modelRefValue(training.defaultModelRef));
    setCreationMode(training.creationMode);
    setAutoApproveEvidence(training.autoApproveEvidence);
  }, [
    preferences.defaultChatModel,
    preferences.defaultChatProvider,
    training.autoApproveEvidence,
    training.creationMode,
    training.defaultModelRef,
  ]);

  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!connection) return;
    setSaving(true);
    onError(null);
    try {
      onPreferences(await api.savePreferences(connection, {
        training: {
          defaultModelRef: nextModelRef,
          creationMode,
          autoApproveEvidence,
        },
      }));
    } catch (error) {
      onError(error instanceof Error ? error.message : String(error));
    } finally {
      setSaving(false);
    }
  }

  return (
    <section className={`account-settings training-settings${embedded ? " embedded" : ""}`}>
      {embedded ? null : <h1>Training</h1>}
      <form className="provider-settings-form" onSubmit={(event) => void save(event)}>
        <div className="account-list-heading">
          <span>Taskset authoring</span>
          <small>The coding model that proposes tasks, graders, fixtures, and policy boundaries</small>
        </div>
        <div className="provider-settings-grid single">
          <label className="settings-select-field">
            <span>Authoring model</span>
            <select
              value={authoringModel}
              disabled={saving}
              onChange={(event) => setAuthoringModel(event.target.value)}
            >
              <option value={DEFAULT_AUTHORING_MODEL}>
                Use chat default — {chatProviderLabel(preferences.defaultChatProvider, providers)} · {chatModelLabel(preferences.defaultChatModel, providers, preferences.defaultChatProvider)}{defaultReasoning}
              </option>
              {authoringModelGroups.map((group) => (
                <optgroup key={group.provider.value} label={group.provider.label}>
                  {group.models.map((model) => (
                    <option key={model.value} value={modelRefValue({ providerId: group.provider.value, modelId: model.value })}>
                      {model.label}
                    </option>
                  ))}
                </optgroup>
              ))}
            </select>
            <small>By default, /train follows the same provider, model, and reasoning level selected for chat.</small>
          </label>
        </div>

        <div className="account-list-heading">
          <span>Default flow</span>
          <small>Used by /train and Task Creator unless you choose another mode</small>
        </div>
        <div className="provider-settings-grid single">
          <label className="settings-select-field">
            <span>Task Creator mode</span>
            <select
              value={creationMode}
              disabled={saving}
              onChange={(event) => setCreationMode(event.target.value as "defaults" | "customize")}
            >
              <option value="customize">Guided plan — review and revise before materializing</option>
              <option value="defaults">Fast draft — use reversible defaults</option>
            </select>
          </label>
        </div>

        <div className="account-list-heading">
          <span>Evidence confirmation</span>
          <small>Controls the first authoring gate; materialization and training remain separate</small>
        </div>
        <label className="settings-check-row">
          <input
            type="checkbox"
            checked={autoApproveEvidence}
            disabled={saving}
            onChange={(event) => setAutoApproveEvidence(event.target.checked)}
          />
          <span>
            <strong>Skip evidence confirmation</strong>
            <small>Immediately send excerpts from explicitly selected chats to the authoring model. This never approves Taskset materialization or training spend.</small>
          </span>
        </label>

        <button className="settings-primary" disabled={saving || unchanged}>
          <span>{saving ? "Saving" : "Save training settings"}</span>
        </button>
      </form>

      <div className="settings-footnote">
        <span>Authoring model</span>
        <strong>{nextModelRef ? `${chatProviderLabel(nextModelRef.providerId, providers)} / ${chatModelLabel(nextModelRef.modelId, providers, nextModelRef.providerId)}` : "Chat default"}</strong>
      </div>
      <div className="settings-footnote">
        <span>Safety boundary</span>
        <strong>Taskset and training approvals always required</strong>
      </div>
    </section>
  );
}

function modelRefValue(model: ChatModelRef | null | undefined): string {
  return model ? JSON.stringify([model.providerId, model.modelId]) : DEFAULT_AUTHORING_MODEL;
}

function modelRefFromValue(value: string): ChatModelRef | null {
  if (value === DEFAULT_AUTHORING_MODEL) return null;
  try {
    const parsed = JSON.parse(value) as unknown;
    if (!Array.isArray(parsed) || parsed.length !== 2 || typeof parsed[0] !== "string" || typeof parsed[1] !== "string") return null;
    return { providerId: parsed[0] as ChatModelRef["providerId"], modelId: parsed[1] };
  } catch {
    return null;
  }
}

function titleCase(value: string): string {
  return `${value.slice(0, 1).toUpperCase()}${value.slice(1)}`;
}

function modelRefsEqual(
  left: AppPreferences["training"]["defaultModelRef"],
  right: AppPreferences["training"]["defaultModelRef"],
): boolean {
  return left?.providerId === right?.providerId && left?.modelId === right?.modelId;
}
