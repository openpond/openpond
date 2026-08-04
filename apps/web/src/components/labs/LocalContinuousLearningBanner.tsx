import { useCallback, useEffect, useMemo, useState } from "react";
import type {
  LocalContinuousLearningState,
  LocalContinuousLearningDefinition,
} from "@openpond/contracts";

import { api, type ClientConnection } from "../../api";
import { AppDialog } from "../dialogs/AppDialog";

export function LocalContinuousLearningBanner({
  connection,
  profileId,
  signedIn,
  onOpenResult,
}: {
  connection: ClientConnection | null;
  profileId: string;
  signedIn: boolean;
  onOpenResult: (sessionId: string) => void;
}) {
  const [states, setStates] = useState<LocalContinuousLearningState[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [setupOpen, setSetupOpen] = useState(false);
  const [onboardingClosed, setOnboardingClosed] = useState(false);
  const state = useMemo(
    () => states.find((item) => item.profileId === profileId) ?? null,
    [profileId, states],
  );
  const refresh = useCallback(async (ignore?: { value: boolean }) => {
    if (!connection) {
      setStates([]);
      setLoaded(true);
      return;
    }
    try {
      const result = await api.localContinuousLearning(connection);
      if (!ignore?.value) {
        setStates(result.states);
        setError(null);
        setLoaded(true);
      }
    } catch (loadError) {
      if (!ignore?.value) {
        setError(loadError instanceof Error ? loadError.message : String(loadError));
        setLoaded(true);
      }
    }
  }, [connection]);

  useEffect(() => {
    const ignore = { value: false };
    void refresh(ignore);
    return () => { ignore.value = true; };
  }, [refresh]);

  const currentDefinition = state
    ? state.definitions.find((item) => item.id === state.currentDefinitionId) ?? null
    : null;
  const activeRun = state?.runs.find((run) => run.status === "running" || run.status === "queued") ?? null;
  const showOnboarding = loaded
    && signedIn
    && !state
    && !onboardingClosed
    && !setupOpen;

  async function update(action: () => Promise<unknown>) {
    setBusy(true);
    setError(null);
    try {
      await action();
      await refresh();
    } catch (actionError) {
      setError(actionError instanceof Error ? actionError.message : String(actionError));
    } finally {
      setBusy(false);
    }
  }

  async function dismissOnboarding() {
    setOnboardingClosed(true);
    if (!connection) return;
    await update(() => api.ensureLocalContinuousLearning(connection, {
      profileId,
      scope: "personal",
      enabled: false,
      onboardingDecision: "dismissed",
    }));
  }

  return (
    <>
      <section className="models-learning-banner" aria-label="Continuous learning">
        <div className="models-learning-copy">
          <span className="models-learning-eyebrow">Saved Work · on this device</span>
          <h2>Turn conversations into Tasksets</h2>
          <p>
            Periodically review conversations you explicitly allow and suggest repeated,
            measurable work worth evaluating. Nothing is trained or materialized without approval.
          </p>
          {state?.schedule.enabled ? (
            <small>
              Nightly at {state.schedule.localTime} · {state.schedule.timezone} · Next {formatDate(state.schedule.nextRunAt)}
            </small>
          ) : (
            <small>The schedule and its history live only in this Desktop profile.</small>
          )}
          {error ? <span className="models-learning-error" role="alert">{error}</span> : null}
        </div>
        <div className="models-learning-actions">
          {state ? (
            <>
              <button
                className="settings-secondary"
                disabled={busy || Boolean(activeRun)}
                type="button"
                onClick={() => void update(() => api.runLocalContinuousLearning(connection!, state.id))}
              >
                {activeRun ? "Reviewing…" : "Run now"}
              </button>
              {state.schedule.latestResultSessionId ? (
                <button
                  className="settings-secondary"
                  type="button"
                  onClick={() => onOpenResult(state.schedule.latestResultSessionId!)}
                >
                  Latest result
                </button>
              ) : null}
              <button className="settings-secondary" type="button" onClick={() => setSetupOpen(true)}>
                View schedule
              </button>
              <button
                className="settings-primary"
                disabled={busy}
                type="button"
                onClick={() => void update(() => api.patchLocalContinuousLearning(
                  connection!,
                  state.id,
                  { enabled: !state.schedule.enabled },
                ))}
              >
                {state.schedule.enabled ? "Pause" : "Resume"}
              </button>
            </>
          ) : (
            <button className="settings-primary" type="button" onClick={() => setSetupOpen(true)}>
              Review on this device
            </button>
          )}
        </div>
      </section>
      {setupOpen ? (
        <LocalContinuousLearningSetupDialog
          busy={busy}
          connection={connection}
          definition={currentDefinition}
          initialState={state}
          profileId={profileId}
          onClose={() => setSetupOpen(false)}
          onSave={(request) => update(async () => {
            if (!connection) throw new Error("Connect to the local OpenPond server first.");
            await api.ensureLocalContinuousLearning(connection, request);
            setSetupOpen(false);
          })}
        />
      ) : null}
      {showOnboarding ? (
        <AppDialog
          ariaLabel="Set up continuous learning"
          className="models-learning-dialog"
          initialFocusKey={profileId}
          onClose={() => void dismissOnboarding()}
        >
          <header>
            <div>
              <h2>Let Models learn from repeated work</h2>
              <p>Choose which conversations are eligible separately. A schedule never grants consent.</p>
            </div>
          </header>
          <div className="models-learning-dialog-body">
            <p>Desktop runs this Saved Work while the app is open and catches up once after a missed occurrence.</p>
          </div>
          <footer>
            <button type="button" disabled={busy} onClick={() => void dismissOnboarding()}>Not now</button>
            <button type="button" disabled={busy} onClick={() => {
              setOnboardingClosed(true);
              setSetupOpen(true);
            }}>Choose schedule</button>
            <button
              className="settings-primary"
              disabled={busy || !connection}
              type="button"
              onClick={() => void update(async () => {
                await api.ensureLocalContinuousLearning(connection!, {
                  profileId,
                  scope: "personal",
                  enabled: true,
                  onboardingDecision: "enabled",
                });
                setOnboardingClosed(true);
              })}
            >Enable nightly review</button>
          </footer>
        </AppDialog>
      ) : null}
    </>
  );
}

function LocalContinuousLearningSetupDialog({
  busy,
  connection,
  definition,
  initialState,
  profileId,
  onClose,
  onSave,
}: {
  busy: boolean;
  connection: ClientConnection | null;
  definition: LocalContinuousLearningDefinition | null;
  initialState: LocalContinuousLearningState | null;
  profileId: string;
  onClose: () => void;
  onSave: (request: Parameters<typeof api.ensureLocalContinuousLearning>[1]) => Promise<void>;
}) {
  const [scope, setScope] = useState<"personal" | "my_team">(initialState?.scope ?? "personal");
  const [workspaceId, setWorkspaceId] = useState(initialState?.workspaceId ?? "");
  const [localTime, setLocalTime] = useState(initialState?.schedule.localTime ?? "02:00");
  const [timezone, setTimezone] = useState(
    initialState?.schedule.timezone ?? Intl.DateTimeFormat().resolvedOptions().timeZone ?? "UTC",
  );
  const [provider, setProvider] = useState(definition?.model.provider ?? "openpond");
  const [model, setModel] = useState(definition?.model.model ?? "openpond-chat");
  const [reasoningEffort, setReasoningEffort] = useState<"low" | "medium" | "high">(
    definition?.model.reasoningEffort ?? "high",
  );

  return (
    <AppDialog ariaLabel="Continuous learning schedule" className="models-learning-dialog" onClose={onClose}>
      <header>
        <div>
          <h2>Continuous learning schedule</h2>
          <p>This local Saved Work creates a normal Work result. It never starts training.</p>
        </div>
      </header>
      <form onSubmit={(event) => {
        event.preventDefault();
        void onSave({
          profileId,
          scope,
          workspaceId: scope === "my_team" ? workspaceId : null,
          enabled: true,
          localTime,
          timezone,
          onboardingDecision: "enabled",
          model: { provider, model, reasoningEffort },
        });
      }}>
        <div className="models-learning-dialog-body">
          <fieldset>
            <legend>Conversation scope</legend>
            <label><input checked={scope === "personal"} name="scope" type="radio" onChange={() => setScope("personal")} /> Personal</label>
            <label><input checked={scope === "my_team"} name="scope" type="radio" onChange={() => setScope("my_team")} /> My Team</label>
            <label aria-disabled="true"><input disabled name="scope" type="radio" /> Full Team <small>Coming later — Team-wide consent required</small></label>
          </fieldset>
          {scope === "my_team" ? (
            <label><span>Team workspace ID</span><input required value={workspaceId} onChange={(event) => setWorkspaceId(event.currentTarget.value)} /></label>
          ) : null}
          <div className="models-learning-grid">
            <label><span>Daily time</span><input required type="time" value={localTime} onChange={(event) => setLocalTime(event.currentTarget.value)} /></label>
            <label><span>Timezone</span><input required value={timezone} onChange={(event) => setTimezone(event.currentTarget.value)} /></label>
            <label><span>Provider</span><input required value={provider} onChange={(event) => setProvider(event.currentTarget.value)} /></label>
            <label><span>Model</span><input required value={model} onChange={(event) => setModel(event.currentTarget.value)} /></label>
            <label><span>Reasoning</span><select value={reasoningEffort} onChange={(event) => setReasoningEffort(event.currentTarget.value as typeof reasoningEffort)}><option value="low">Low</option><option value="medium">Medium</option><option value="high">High</option></select></label>
          </div>
          <p className="models-learning-disclosure">
            The schedule and evidence selection run on this device. Conversation excerpts are sent to the selected model provider; choose a local provider to keep inference on-device.
          </p>
          {!connection ? <p className="models-learning-error">Connect to the local server to save this schedule.</p> : null}
        </div>
        <footer>
          <button disabled={busy} type="button" onClick={onClose}>Cancel</button>
          <button className="settings-primary" disabled={busy || !connection} type="submit">{busy ? "Saving…" : "Save and enable"}</button>
        </footer>
      </form>
    </AppDialog>
  );
}

function formatDate(value: string | null): string {
  if (!value) return "after the app starts";
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? "pending" : parsed.toLocaleString();
}
