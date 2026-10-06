import { useEffect, useState } from "react";
import { apiFetch, type ClientConnection } from "../../api/api-client";

type Selection = { providerId: string; modelId: string; reasoningEffort: string };
type Settings = {
  model: Selection | null;
  watchHostedThreads: boolean;
  watchLocalThreads: boolean;
  watchWorkflows: boolean;
  notifications: "off" | "attention" | "all";
  supervision: { mode: "off" | "recommend"; intervalMinutes: 5 | 10 };
};
type Payload = {
  settings: Settings;
  models: Array<
    Selection & {
      displayName: string;
      defaultReasoningEffort: string;
      reasoningOptions: Array<{ value: string; label: string }>;
    }
  >;
};

export function PonderSettingsSection({ connection }: { connection: ClientConnection | null }) {
  const [payload, setPayload] = useState<Payload | null>(null);
  const [draft, setDraft] = useState<Settings>({
    model: null,
    watchHostedThreads: true,
    watchLocalThreads: true,
    watchWorkflows: true,
    notifications: "attention",
    supervision: { mode: "off", intervalMinutes: 5 },
  });
  const [reload, setReload] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [notifications, setNotifications] = useState(
    () => localStorage.getItem("openpond:ponder-notifications") === "on",
  );
  useEffect(() => {
    if (!connection) return;
    const controller = new AbortController();
    setPayload(null);
    setDraft({
      model: null,
      watchHostedThreads: true,
      watchLocalThreads: true,
      watchWorkflows: true,
      notifications: "attention",
      supervision: { mode: "off", intervalMinutes: 5 },
    });
    setError(null);
    void apiFetch<Payload>(connection, "/v1/ponder/settings", { signal: controller.signal })
      .then((value) => {
        setPayload(value);
        setDraft(value.settings);
      })
      .catch((cause) => {
        if (!controller.signal.aborted)
          setError(cause instanceof Error ? cause.message : String(cause));
      });
    return () => controller.abort();
  }, [connection, reload]);
  async function save() {
    if (!connection || !payload || saving) return;
    setSaving(true);
    try {
      const value = await apiFetch<{ settings: Settings }>(connection, "/v1/ponder/settings", {
        method: "POST",
        body: JSON.stringify(draft),
      });
      setDraft(value.settings);
      setError(null);
      window.dispatchEvent(new Event("ponder-settings-changed"));
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setSaving(false);
    }
  }
  async function enableNotifications() {
    if (!notifications && !window.openpond?.notify) {
      if (!("Notification" in window)) {
        setError("Notifications are unavailable in this browser.");
        return;
      }
      if ((await Notification.requestPermission()) !== "granted") {
        setError("Allow notifications in your browser settings to enable them.");
        return;
      }
    }
    const enabled = !notifications;
    setNotifications(enabled);
    localStorage.setItem("openpond:ponder-notifications", enabled ? "on" : "off");
  }
  const selected = payload?.models.find(
    (model) =>
      model.modelId === draft?.model?.modelId && model.providerId === draft?.model?.providerId,
  );
  return (
    <section className="account-settings">
      <header className="section-heading">
        <h2>Ponder Pal</h2>
        <p>Use your deployed model and keep track of your conversations and workflows.</p>
      </header>
      {error && <p role="alert">{error}</p>}
      {error && !payload && (
        <button type="button" onClick={() => setReload((value) => value + 1)}>
          Retry
        </button>
      )}
      {!payload && !error && <p role="status">Fetching model choices and saved preferences…</p>}
      <fieldset disabled={!payload || saving} className="account-list">
        <label>
          Model
          <select
            value={draft.model ? `${draft.model.providerId}|${draft.model.modelId}` : "default"}
            onChange={(event) => {
              const model = payload?.models.find(
                (item) => `${item.providerId}|${item.modelId}` === event.target.value,
              );
              setDraft({
                ...draft,
                model: model
                  ? {
                      providerId: model.providerId,
                      modelId: model.modelId,
                      reasoningEffort: model.defaultReasoningEffort,
                    }
                  : null,
              });
            }}
          >
            <option value="default">Ponder model — shared Qwen, then your accepted version</option>
            {payload?.models.map((model) => (
              <option
                key={`${model.providerId}|${model.modelId}`}
                value={`${model.providerId}|${model.modelId}`}
              >
                {model.displayName}
              </option>
            ))}
            {draft.model && !selected && (
              <option value={`${draft.model.providerId}|${draft.model.modelId}`}>
                Selected model is unavailable
              </option>
            )}
          </select>
        </label>
        {selected && selected.reasoningOptions.length > 0 && (
          <label>
            Reasoning
            <select
              value={draft.model?.reasoningEffort}
              onChange={(event) =>
                setDraft({
                  ...draft,
                  model: { ...draft.model!, reasoningEffort: event.target.value },
                })
              }
            >
              {selected.reasoningOptions.map((option) => (
                <option key={option.value} value={option.value}>
                  {option.label}
                </option>
              ))}
            </select>
          </label>
        )}
        <p>Your trained model appears here once it is deployed and available to your account.</p>
        {(
          [
            ["watchHostedThreads", "Follow hosted conversations"],
            ["watchLocalThreads", "Share local thread titles and run status"],
            ["watchWorkflows", "Follow workflows and their runs"],
          ] as const
        ).map(([key, label]) => (
          <label key={key}>
            <input
              type="checkbox"
              checked={draft[key]}
              onChange={(event) => setDraft({ ...draft, [key]: event.target.checked })}
            />
            {label}
          </label>
        ))}
        <p>
          Activity gives Ponder Pal context. It does not automatically message or change your tasks.
        </p>
        <label>
          <input type="checkbox" checked={draft.supervision.mode === "recommend"}
            onChange={event => setDraft({ ...draft, supervision: { ...draft.supervision, mode: event.target.checked ? "recommend" : "off" } })} />
          Recommend changes when hosted work needs attention
        </label>
        <label>
          Check for missed updates
          <select value={draft.supervision.intervalMinutes}
            onChange={event => setDraft({ ...draft, supervision: { ...draft.supervision, intervalMinutes: Number(event.target.value) as 5 | 10 } })}>
            <option value={5}>Every 5 minutes</option><option value={10}>Every 10 minutes</option>
          </select>
        </label>
        <p>Task updates trigger reviews. Unchanged work is skipped. You review and send each proposed message.</p>
        <label>
          Notifications
          <select
            value={draft.notifications}
            onChange={(event) =>
              setDraft({ ...draft, notifications: event.target.value as Settings["notifications"] })
            }
          >
            <option value="off">Off</option>
            <option value="attention">Completions and things that need attention</option>
            <option value="all">All activity</option>
          </select>
        </label>
        <button type="button" onClick={() => void enableNotifications()}>
          {notifications
            ? "Disable notifications on this device"
            : "Enable notifications on this device"}
        </button>
        <button type="button" disabled={!payload || saving} onClick={() => void save()}>
          {saving ? "Saving…" : "Save"}
        </button>
      </fieldset>
    </section>
  );
}
