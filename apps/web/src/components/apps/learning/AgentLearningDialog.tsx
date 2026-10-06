import { useEffect, useRef, useState } from "react";
import type { ClientConnection } from "../../../api/api-client";
import { X } from "../../icons";
import { useAgentDialogFocus } from "../useAgentDialogFocus";
import { initialLearningDraft, submitLearningDraft, type LearningDraft } from "./draft";
import type { ConversationPolicy, SourceBinding } from "./contracts";
import type { useLearningOptions } from "./client";
import { LearningSourcesFields } from "./LearningSourcesFields";
import { LearningPreparationFields } from "./LearningPreparationFields";
import { LearningScheduleFields } from "./LearningScheduleFields";
import "../../../styles/apps/agent-learning.css";

type Tab = "sources" | "preparation" | "schedule";
export function AgentLearningDialog({
  connection,
  teamId,
  projectId,
  projectName,
  initialPolicy,
  bindings,
  query,
  onClose,
}: {
  connection: ClientConnection;
  teamId: string;
  projectId: string;
  projectName: string;
  initialPolicy?: ConversationPolicy;
  bindings: SourceBinding[];
  query: ReturnType<typeof useLearningOptions>;
  onClose(): void;
}) {
  const [policy, setPolicy] = useState(initialPolicy);
  const [draft, setDraft] = useState(() =>
    initialLearningDraft(projectId, initialPolicy, initialPolicy ? [] : bindings),
  );
  const [initialized, setInitialized] = useState(Boolean(query.data));
  const [dirty, setDirty] = useState(false),
    [saving, setSaving] = useState(false),
    [error, setError] = useState<string | null>(null);
  const [enabled, setEnabled] = useState(initialPolicy?.status === "enabled" || !initialPolicy);
  const [tab, setTab] = useState<Tab>("sources"),
    [discard, setDiscard] = useState(false),
    [pendingPolicy, setPendingPolicy] = useState<string | null>(null);
  const initializedRef = useRef(initialized);
  initializedRef.current = initialized;
  const policies =
    query.data?.policies.filter((item) => item.configuration.projectId === projectId) ?? [];
  useEffect(() => {
    if (!query.data || initializedRef.current) return;
    const existing =
      query.data.policies.find(
        (item) => item.configuration.projectId === projectId && item.status === "enabled",
      ) ?? query.data.policies.find((item) => item.configuration.projectId === projectId);
    setPolicy(existing);
    setDraft(initialLearningDraft(projectId, existing, existing ? [] : bindings));
    setEnabled(existing?.status === "enabled" || !existing);
    setInitialized(true);
  }, [query.data, projectId, bindings]);
  const requestClose = () => {
    if (saving) return;
    if (dirty) setDiscard(true);
    else onClose();
  };
  const ref = useAgentDialogFocus(requestClose);
  function loadPolicy(id: string) {
    const existing = policies.find((item) => item.id === id);
    if (!existing) return;
    setPolicy(existing);
    setDraft(initialLearningDraft(projectId, existing));
    setEnabled(existing.status === "enabled");
    setDirty(false);
    setPendingPolicy(null);
    setDiscard(false);
    setError(null);
  }
  function change(value: LearningDraft) {
    setDraft(value);
    setDirty(true);
  }
  async function save() {
    if (!query.data || !initialized || saving || query.isError) return;
    setSaving(true);
    setError(null);
    try {
      await submitLearningDraft(connection, teamId, draft, query.data, policy, enabled);
      await query.refresh();
      setDirty(false);
      onClose();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Unable to save continual learning.");
    } finally {
      setSaving(false);
    }
  }
  const fields = { draft, options: query.data, loading: query.isPending, onChange: change };
  return (
    <div className="git-dialog-backdrop provider-dialog-backdrop" onMouseDown={requestClose}>
      <section
        ref={ref}
        className="git-dialog provider-details-dialog agent-learning-dialog"
        role="dialog"
        aria-modal="true"
        aria-label="Continual learning"
        onMouseDown={(event) => event.stopPropagation()}
      >
        <button
          type="button"
          className="git-dialog-close"
          aria-label="Close continual learning"
          disabled={saving}
          onClick={requestClose}
        >
          <X size={16} />
        </button>
        <div className="provider-dialog-header">
          <div>
            <h2>Continual learning</h2>
            <span>{projectName}</span>
          </div>
        </div>
        {discard ? (
          <div className="agent-learning-discard" role="alert">
            <p>Discard unsaved policy changes?</p>
            <div className="settings-button-row">
              <button
                type="button"
                onClick={() => {
                  setDiscard(false);
                  setPendingPolicy(null);
                }}
              >
                Keep editing
              </button>
              <button
                type="button"
                onClick={() => (pendingPolicy ? loadPolicy(pendingPolicy) : onClose())}
              >
                Discard changes
              </button>
            </div>
          </div>
        ) : null}
        {policies.length > 1 ? (
          <label className="agent-learning-policy-picker">
            Learning policy
            <select
              disabled={saving}
              value={policy?.id ?? ""}
              onChange={(event) => {
                if (dirty) {
                  setPendingPolicy(event.target.value);
                  setDiscard(true);
                } else loadPolicy(event.target.value);
              }}
            >
              {policies.map((item) => (
                <option key={item.id} value={item.id}>
                  {item.configuration.name} ({item.status})
                </option>
              ))}
            </select>
          </label>
        ) : null}
        <div
          className="surface-tabs provider-agent-tabs"
          role="tablist"
          aria-label="Continual learning settings"
        >
          {(
            [
              ["sources", "Sources & rubrics"],
              ["preparation", "Preparation"],
              ["schedule", "Run window & budget"],
            ] as const
          ).map(([id, label]) => (
            <button
              type="button"
              id={`learning-tab-${id}`}
              key={id}
              role="tab"
              aria-selected={tab === id}
              aria-controls={`learning-panel-${id}`}
              tabIndex={tab === id ? 0 : -1}
              onClick={() => setTab(id)}
              onKeyDown={(event) => {
                const tabs: Tab[] = ["sources", "preparation", "schedule"];
                const index = tabs.indexOf(id);
                if (["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) {
                  event.preventDefault();
                  const next =
                    tabs[
                      event.key === "Home"
                        ? 0
                        : event.key === "End"
                          ? 2
                          : (index + (event.key === "ArrowRight" ? 1 : 2)) % 3
                    ]!;
                  setTab(next);
                  document.getElementById(`learning-tab-${next}`)?.focus();
                }
              }}
            >
              {label}
            </button>
          ))}
        </div>
        <form
          className="agent-learning-form"
          onSubmit={(event) => {
            event.preventDefault();
            void save();
          }}
        >
          <fieldset disabled={!initialized || saving}>
            <label>
              Policy name
              <input
                required
                maxLength={200}
                value={draft.name}
                onChange={(event) => change({ ...draft, name: event.target.value })}
              />
            </label>
          </fieldset>
          <div id={`learning-panel-${tab}`} role="tabpanel" aria-labelledby={`learning-tab-${tab}`}>
            <fieldset disabled={!initialized || saving}>
              {tab === "sources" ? (
                <LearningSourcesFields {...fields} />
              ) : tab === "preparation" ? (
                <LearningPreparationFields {...fields} />
              ) : (
                <LearningScheduleFields {...fields} />
              )}
            </fieldset>
          </div>
          {query.isPending ? (
            <p role="status">Fetching available sources, rubrics and models…</p>
          ) : null}
          {query.isError ? (
            <p role="alert">
              {query.error.message}{" "}
              <button type="button" onClick={() => void query.refetch()}>
                Retry settings
              </button>
            </p>
          ) : null}
          {error ? <p role="alert">{error}</p> : null}
          <label className="agent-learning-check">
            <input
              type="checkbox"
              checked={enabled}
              disabled={!initialized || saving}
              onChange={(event) => {
                setEnabled(event.target.checked);
                setDirty(true);
              }}
            />
            Enable this policy after saving
          </label>
          <p>
            Saving enables only the reviewed sources, schedule and limits. No training is dispatched
            by opening this dialog.
          </p>
          <div className="settings-button-row agent-learning-footer">
            <button type="button" disabled={saving} onClick={requestClose}>
              Cancel
            </button>
            <button
              type="submit"
              className="primary"
              disabled={
                !initialized || !query.data || query.isError || saving || !draft.sourceKeys.length
              }
            >
              {saving ? "Saving…" : enabled ? "Save and enable" : "Save paused"}
            </button>
          </div>
        </form>
      </section>
    </div>
  );
}
