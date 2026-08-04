import { useCallback, useEffect, useMemo, useState } from "react";
import type {
  LocalContinuousLearningDefinition,
  LocalContinuousLearningState,
} from "@openpond/contracts";

import { api, type ClientConnection } from "../../api";
import { AppDialog } from "../dialogs/AppDialog";
import { X } from "../icons";

const CONTINUOUS_LEARNING_DOCS_URL =
  "https://openpond.ai/docs/continuous-learning";
const CONTINUOUS_LEARNING_CHANGED_EVENT =
  "openpond:continuous-learning-changed";
let pendingContinuousLearningRequest: {
  connection: ClientConnection;
  promise: ReturnType<typeof api.localContinuousLearning>;
} | null = null;

function loadLocalContinuousLearning(connection: ClientConnection) {
  if (pendingContinuousLearningRequest?.connection === connection) {
    return pendingContinuousLearningRequest.promise;
  }
  const request = api.localContinuousLearning(connection);
  pendingContinuousLearningRequest = { connection, promise: request };
  const clearPending = () => {
    if (pendingContinuousLearningRequest?.promise === request) {
      pendingContinuousLearningRequest = null;
    }
  };
  void request.then(clearPending, clearPending);
  return request;
}

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
  const control = useLocalContinuousLearningControl({
    connection,
    profileId,
  });
  const {
    activeRun,
    busy,
    currentDefinition,
    enabled,
    loaded,
    setEnabled,
    state,
    update,
  } = control;
  const [scheduleOpen, setScheduleOpen] = useState(false);

  return (
    <>
      <section
        className="models-learning-banner"
        aria-label="Continuous learning"
      >
        <div className="models-learning-header">
          <h2>Enable continuous learning</h2>
          <div className="models-learning-control-row">
            <button
              className="models-learning-link"
              onClick={() => void openContinuousLearningDocs()}
              type="button"
            >
              Docs
            </button>
            <button
              aria-checked={enabled}
              aria-label="Continuous learning"
              className={`models-learning-switch${enabled ? " checked" : ""}`}
              disabled={!loaded || !signedIn || !connection || busy}
              onClick={() => void setEnabled(!enabled)}
              role="switch"
              type="button"
            >
              <span />
            </button>
          </div>
        </div>
        <div className="models-learning-content-row">
          <p>
            Periodically review eligible conversations and suggest repeated,
            measurable work worth evaluating; training and Version changes
            always require approval.
          </p>
          {enabled ? (
            <button
              className="models-learning-link"
              onClick={() => setScheduleOpen(true)}
              type="button"
            >
              View
            </button>
          ) : null}
        </div>
      </section>
      {scheduleOpen && state ? (
        <LocalContinuousLearningScheduleDialog
          activeRun={activeRun}
          busy={busy}
          connection={connection}
          definition={currentDefinition}
          initialState={state}
          onClose={() => setScheduleOpen(false)}
          onOpenResult={onOpenResult}
          onRunNow={() =>
            update(() => api.runLocalContinuousLearning(connection!, state.id))
          }
          onSave={(request) =>
            update(async () => {
              if (!connection) {
                throw new Error("Connect to the local OpenPond server first.");
              }
              await api.ensureLocalContinuousLearning(connection, request);
              setScheduleOpen(false);
            })
          }
        />
      ) : null}
    </>
  );
}

export function LocalContinuousLearningSidebarNotice({
  connection,
  profileId,
  signedIn,
}: {
  connection: ClientConnection | null;
  profileId: string;
  signedIn: boolean;
}) {
  const { busy, enabled, loaded, setEnabled } =
    useLocalContinuousLearningControl({ connection, profileId });
  const storageKey = `openpond.continuous-learning-notice-dismissed.${profileId}`;
  const [dismissed, setDismissed] = useState(true);

  useEffect(() => {
    setDismissed(window.localStorage.getItem(storageKey) === "true");
  }, [storageKey]);

  if (!loaded || enabled || dismissed) return null;

  return (
    <section
      className="sidebar-learning-notice"
      aria-label="Continuous learning beta"
    >
      <header>
        <strong>Continuous learning (beta)</strong>
        <div className="sidebar-learning-notice-actions">
          <button
            aria-checked={false}
            aria-label="Enable continuous learning"
            className="models-learning-switch"
            disabled={!signedIn || !connection || busy}
            onClick={() => void setEnabled(true)}
            role="switch"
            type="button"
          >
            <span />
          </button>
          <button
            aria-label="Dismiss continuous learning"
            className="sidebar-learning-notice-dismiss"
            onClick={() => {
              window.localStorage.setItem(storageKey, "true");
              setDismissed(true);
            }}
            type="button"
          >
            <X size={14} />
          </button>
        </div>
      </header>
      <p>Review eligible conversations for repeated work worth evaluating.</p>
    </section>
  );
}

function useLocalContinuousLearningControl({
  connection,
  profileId,
}: {
  connection: ClientConnection | null;
  profileId: string;
}) {
  const [states, setStates] = useState<LocalContinuousLearningState[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [busy, setBusy] = useState(false);
  const state = useMemo(
    () => states.find((item) => item.profileId === profileId) ?? null,
    [profileId, states],
  );
  const refresh = useCallback(
    async (ignore?: { value: boolean }) => {
      if (!connection) {
        setStates([]);
        setLoaded(true);
        return;
      }
      try {
        const result = await loadLocalContinuousLearning(connection);
        if (!ignore?.value) {
          setStates(result.states);
          setLoaded(true);
        }
      } catch {
        if (!ignore?.value) {
          setLoaded(true);
        }
      }
    },
    [connection],
  );

  useEffect(() => {
    const ignore = { value: false };
    void refresh(ignore);
    return () => {
      ignore.value = true;
    };
  }, [refresh]);

  useEffect(() => {
    const handleChanged = () => void refresh();
    window.addEventListener(CONTINUOUS_LEARNING_CHANGED_EVENT, handleChanged);
    return () =>
      window.removeEventListener(
        CONTINUOUS_LEARNING_CHANGED_EVENT,
        handleChanged,
      );
  }, [refresh]);

  const currentDefinition = state
    ? state.definitions.find((item) => item.id === state.currentDefinitionId) ??
      null
    : null;
  const activeRun =
    state?.runs.find(
      (run) => run.status === "running" || run.status === "queued",
    ) ?? null;
  const enabled = state?.schedule.enabled === true;

  async function update(action: () => Promise<unknown>) {
    setBusy(true);
    try {
      await action();
      await refresh();
      window.dispatchEvent(new Event(CONTINUOUS_LEARNING_CHANGED_EVENT));
    } catch {
      // The surrounding product remains usable when the local scheduler is unavailable.
    } finally {
      setBusy(false);
    }
  }

  async function setEnabled(nextEnabled: boolean) {
    if (!connection) {
      return;
    }
    await update(() =>
      state
        ? api.patchLocalContinuousLearning(connection, state.id, {
            enabled: nextEnabled,
          })
        : api.ensureLocalContinuousLearning(connection, {
            profileId,
            scope: "personal",
            enabled: nextEnabled,
            onboardingDecision: "enabled",
          }),
    );
  }

  return {
    activeRun,
    busy,
    currentDefinition,
    enabled,
    loaded,
    setEnabled,
    state,
    update,
  };
}

function LocalContinuousLearningScheduleDialog({
  activeRun,
  busy,
  connection,
  definition,
  initialState,
  onClose,
  onOpenResult,
  onRunNow,
  onSave,
}: {
  activeRun: LocalContinuousLearningState["runs"][number] | null;
  busy: boolean;
  connection: ClientConnection | null;
  definition: LocalContinuousLearningDefinition | null;
  initialState: LocalContinuousLearningState;
  onClose: () => void;
  onOpenResult: (sessionId: string) => void;
  onRunNow: () => Promise<void>;
  onSave: (
    request: Parameters<typeof api.ensureLocalContinuousLearning>[1],
  ) => Promise<void>;
}) {
  const [localTime, setLocalTime] = useState(initialState.schedule.localTime);
  const [timezone, setTimezone] = useState(
    initialState.schedule.timezone ??
      Intl.DateTimeFormat().resolvedOptions().timeZone ??
      "UTC",
  );
  const [provider, setProvider] = useState(
    definition?.model.provider ?? "openpond",
  );
  const [model, setModel] = useState(
    definition?.model.model ?? "openpond-chat",
  );
  const [reasoningEffort, setReasoningEffort] = useState<
    "low" | "medium" | "high"
  >(definition?.model.reasoningEffort ?? "high");

  return (
    <AppDialog
      ariaLabel="Continuous learning schedule"
      className="models-learning-dialog"
      onClose={onClose}
    >
      <header>
        <div>
          <h2>Continuous learning schedule</h2>
          <p>
            Runs on this device while OpenPond is open and catches up once after
            a missed review.
          </p>
        </div>
      </header>
      <form
        onSubmit={(event) => {
          event.preventDefault();
          void onSave({
            profileId: initialState.profileId,
            scope: initialState.scope,
            workspaceId: initialState.workspaceId,
            enabled: true,
            localTime,
            timezone,
            onboardingDecision: "enabled",
            model: { provider, model, reasoningEffort },
          });
        }}
      >
        <div className="models-learning-dialog-body">
          <div className="models-learning-grid">
            <label>
              <span>Daily time</span>
              <input
                required
                type="time"
                value={localTime}
                onChange={(event) => setLocalTime(event.currentTarget.value)}
              />
            </label>
            <label>
              <span>Timezone</span>
              <input
                required
                value={timezone}
                onChange={(event) => setTimezone(event.currentTarget.value)}
              />
            </label>
            <label>
              <span>Provider</span>
              <input
                required
                value={provider}
                onChange={(event) => setProvider(event.currentTarget.value)}
              />
            </label>
            <label>
              <span>Model</span>
              <input
                required
                value={model}
                onChange={(event) => setModel(event.currentTarget.value)}
              />
            </label>
            <label>
              <span>Reasoning</span>
              <select
                value={reasoningEffort}
                onChange={(event) =>
                  setReasoningEffort(
                    event.currentTarget.value as typeof reasoningEffort,
                  )
                }
              >
                <option value="low">Low</option>
                <option value="medium">Medium</option>
                <option value="high">High</option>
              </select>
            </label>
          </div>
          <p className="models-learning-disclosure">
            Conversation excerpts are sent to the selected model provider.
            Choose a local provider to keep inference on this device.
          </p>
          <div className="models-learning-run-row">
            <div>
              <strong>Next review</strong>
              <span>{formatDate(initialState.schedule.nextRunAt)}</span>
            </div>
            <button
              className="models-learning-button secondary"
              disabled={busy || Boolean(activeRun) || !connection}
              onClick={() => void onRunNow()}
              type="button"
            >
              {activeRun ? "Reviewing…" : "Run now"}
            </button>
            {initialState.schedule.latestResultSessionId ? (
              <button
                className="models-learning-button secondary"
                onClick={() =>
                  onOpenResult(initialState.schedule.latestResultSessionId!)
                }
                type="button"
              >
                Latest result
              </button>
            ) : null}
          </div>
        </div>
        <footer>
          <button
            className="models-learning-button secondary"
            disabled={busy}
            onClick={onClose}
            type="button"
          >
            Cancel
          </button>
          <button
            className="models-learning-button primary"
            disabled={busy || !connection}
            type="submit"
          >
            {busy ? "Saving…" : "Save"}
          </button>
        </footer>
      </form>
    </AppDialog>
  );
}

async function openContinuousLearningDocs(): Promise<void> {
  const browser = window.openpond?.browser;
  if (browser?.openExternal) {
    const result = await browser.openExternal({
      conversationId: "openpond-continuous-learning-docs",
      url: CONTINUOUS_LEARNING_DOCS_URL,
    });
    if (result.ok) return;
  }
  window.open(CONTINUOUS_LEARNING_DOCS_URL, "_blank", "noopener,noreferrer");
}

function formatDate(value: string | null): string {
  if (!value) return "After OpenPond starts";
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? "Pending" : parsed.toLocaleString();
}
