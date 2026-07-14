import { useEffect, useState } from "react";
import type { AppPreferences, ChatModelRef, CodexReasoningEffort, ProviderSettings, Session, TaskCreationSnapshot, Taskset } from "@openpond/contracts";
import type { ClientConnection, PreferencesPayload } from "../../api";
import type { ShowAppToast } from "../../app/app-state";
import type { useTraining } from "../../hooks/useTraining";
import { CircleAlert, Loader2, Play, Plus, RefreshCw, Settings } from "../icons";
import { TrainingTasksetDetail } from "./TrainingTasksetDetail";
import { TrainingModels } from "./TrainingModels";
import { TrainingCreationPanel } from "./TrainingCreationPanel";
import { TrainingRunDialog } from "./TrainingRunDialog";
import { TrainingSettingsDialog } from "./TrainingSettingsDialog";
import "../../styles/training/training.css";
import { trainingAuthoringModel } from "./training-flow";

type TrainingController = ReturnType<typeof useTraining>;
type MainTab = "models" | "tasksets";
export type TrainingLaunchRequest = { id: number; objective: string | null; initialSessionIds?: string[] };

export function TrainingView({
  training,
  sessions,
  connection,
  defaultModel,
  onError,
  onToast,
  onSettingsPreferences,
  onOpenChat,
  onChatWithModel,
  onOpenTasksetFiles,
  selectedTasksetId,
  onSelectedTasksetIdChange,
  onSelectedTrainingJobIdChange,
  detailTasksetId,
  onDetailTasksetIdChange,
  launchRequest,
  onLaunchHandled,
  preferences,
  settingsPreferences,
  providerSettings,
  reasoningEffort,
}: {
  training: TrainingController;
  sessions: Session[];
  connection: ClientConnection | null;
  defaultModel: ChatModelRef;
  onError: (message: string | null) => void;
  onToast: ShowAppToast;
  onSettingsPreferences: (payload: PreferencesPayload) => void;
  onOpenChat: (sessionId: string) => void;
  onChatWithModel: (modelId: string) => void;
  onOpenTasksetFiles: () => void;
  selectedTasksetId: string | null;
  onSelectedTasksetIdChange: (id: string | null) => void;
  onSelectedTrainingJobIdChange: (id: string | null) => void;
  detailTasksetId: string | null;
  onDetailTasksetIdChange: (id: string | null) => void;
  launchRequest: TrainingLaunchRequest | null;
  onLaunchHandled: (id: number) => void;
  preferences: AppPreferences["training"];
  settingsPreferences: AppPreferences;
  providerSettings: ProviderSettings | null;
  reasoningEffort: CodexReasoningEffort;
}) {
  const [tab, setTab] = useState<MainTab>("models");
  const [runDialogOpen, setRunDialogOpen] = useState(false);
  const [settingsDialogOpen, setSettingsDialogOpen] = useState(false);
  const state = training.payload;
  const selectedTaskset = state?.tasksets.find((item) => item.id === selectedTasksetId) ?? state?.tasksets[0] ?? null;
  useEffect(() => {
    if (!launchRequest) return;
    setRunDialogOpen(true);
  }, [launchRequest]);

  function closeRunDialog() {
    setRunDialogOpen(false);
    if (launchRequest) onLaunchHandled(launchRequest.id);
  }

  function finishTasksetCreation(creation: TaskCreationSnapshot) {
    setRunDialogOpen(false);
    if (creation.materializedTasksetId) {
      onSelectedTasksetIdChange(creation.materializedTasksetId);
      onDetailTasksetIdChange(creation.materializedTasksetId);
      setTab("models");
    }
    if (launchRequest) onLaunchHandled(launchRequest.id);
  }

  return (
    <section className="training-view" aria-label="Training">
      <div className="training-header">
        <div className="training-tabs training-header-tabs" role="tablist" aria-label="Training sections">
          {(["models", "tasksets"] as const).map((item) => (
            <button key={item} type="button" role="tab" aria-selected={tab === item} className={tab === item ? "active" : ""} onClick={() => { setTab(item); if (item !== "models") onDetailTasksetIdChange(null); }}>
              {label(item)} {countFor(state) ? <span>{countFor(state)}</span> : null}
            </button>
          ))}
        </div>
        <div className="training-header-actions">
          <button className="training-icon-button" type="button" aria-label="Refresh training" title="Refresh" disabled={training.loading} onClick={() => void training.refresh()}>
            <RefreshCw className={training.loading ? "spin" : undefined} size={15} />
          </button>
          <button className="training-button secondary" type="button" onClick={() => setSettingsDialogOpen(true)}>
            <Settings size={14} /> Settings
          </button>
          <button className="training-button" type="button" onClick={() => setRunDialogOpen(true)}>
            <Plus size={14} /> New model
          </button>
        </div>
      </div>

      {training.error ? <div className="training-banner error"><CircleAlert size={15} />{training.error}</div> : null}
      {training.busyAction ? <div className="training-banner"><Loader2 className="spin" size={15} />Working on {training.busyAction.replaceAll("-", " ")}…</div> : null}

      {tab === "models" ? (
        <>
          <TrainingModels
            training={training}
            connection={connection}
            onOpenTasksetFiles={(tasksetId) => { onSelectedTasksetIdChange(tasksetId); onOpenTasksetFiles(); }}
            onOpenTaskset={(tasksetId) => { onSelectedTasksetIdChange(tasksetId); onDetailTasksetIdChange(null); setTab("tasksets"); }}
            onSelectedTasksetIdChange={onSelectedTasksetIdChange}
            onSelectedJobIdChange={onSelectedTrainingJobIdChange}
            onChatWithModel={onChatWithModel}
            onToast={onToast}
            detailTasksetId={detailTasksetId}
            onDetailTasksetIdChange={onDetailTasksetIdChange}
          />
          {state?.candidates.length ? <Suggestions training={training} defaultModel={defaultModel} preferences={preferences} reasoningEffort={reasoningEffort} onPlanStarted={() => setTab("models")} /> : null}
        </>
      ) : tab === "tasksets" ? (
        <TrainingTasksets
          onOpenChat={onOpenChat}
          selectedTaskset={selectedTaskset}
          selectedTasksetId={selectedTaskset?.id ?? null}
          setSelectedTasksetId={onSelectedTasksetIdChange}
          training={training}
        />
      ) : null}

      {runDialogOpen && state ? (
        <TrainingRunDialog
          defaultModel={defaultModel}
          initialObjective={launchRequest?.objective ?? null}
          initialSessionIds={launchRequest?.initialSessionIds ?? []}
          onClose={closeRunDialog}
          onTasksetCreated={finishTasksetCreation}
          preferences={preferences}
          providerSettings={providerSettings}
          reasoningEffort={reasoningEffort}
          sessions={sessions}
          sources={state.sources}
          training={training}
        />
      ) : null}
      {settingsDialogOpen ? (
        <TrainingSettingsDialog
          connection={connection}
          onClose={() => setSettingsDialogOpen(false)}
          onError={onError}
          onPreferences={onSettingsPreferences}
          preferences={settingsPreferences}
          providers={providerSettings}
        />
      ) : null}
    </section>
  );
}

function TrainingTasksets({
  onOpenChat,
  selectedTaskset,
  selectedTasksetId,
  setSelectedTasksetId,
  training,
}: {
  onOpenChat: (sessionId: string) => void;
  selectedTaskset: Taskset | null;
  selectedTasksetId: string | null;
  setSelectedTasksetId: (id: string | null) => void;
  training: TrainingController;
}) {
  const state = training.payload;
  const activeCreation = state?.creations.find((creation) =>
    !["cancelled", "failed", "ready"].includes(creation.state)) ?? null;
  return (
    <div className="training-workbench">
      {activeCreation ? (
        <section className="training-active-plan">
          <div className="training-section-heading"><div><h2>Current plan</h2><p>Review the authoring model’s proposal before creating a Taskset.</p></div></div>
          <TrainingCreationPanel creation={activeCreation} training={training} />
        </section>
      ) : null}

      <section className="training-workbench-section">
        <label className="training-taskset-selector">
          <select aria-label="Taskset" disabled={!state?.tasksets.length} value={selectedTasksetId ?? ""} onChange={(event) => setSelectedTasksetId(event.target.value || null)}>
            {!state?.tasksets.length ? <option value="">No Tasksets yet</option> : null}
            {state?.tasksets.map((taskset) => <option key={taskset.id} value={taskset.id}>{taskset.name}</option>)}
          </select>
        </label>
        {selectedTaskset ? (
          <main className="training-detail">
            <TrainingTasksetDetail taskset={selectedTaskset} training={training} onOpenChat={onOpenChat} />
          </main>
        ) : <EmptyDetail />}
      </section>

    </div>
  );
}

function Suggestions({ training, defaultModel, preferences, reasoningEffort, onPlanStarted }: { training: TrainingController; defaultModel: ChatModelRef; preferences: AppPreferences["training"]; reasoningEffort: CodexReasoningEffort; onPlanStarted: () => void }) {
  const state = training.payload;
  return <section className="training-page-body training-suggestions"><h2>Suggested experiments</h2>{state?.candidates.length ? <div className="training-card-grid">{state.candidates.map((candidate) => <SuggestionCard key={candidate.id} candidate={candidate} candidates={state.candidates} training={training} defaultModel={defaultModel} preferences={preferences} reasoningEffort={reasoningEffort} onPlanStarted={onPlanStarted}/>)}</div> : null}</section>;
}

function SuggestionCard({ candidate, candidates, training, defaultModel, preferences, reasoningEffort, onPlanStarted }: { candidate: NonNullable<TrainingController["payload"]>["candidates"][number]; candidates: NonNullable<TrainingController["payload"]>["candidates"]; training: TrainingController; defaultModel: ChatModelRef; preferences: AppPreferences["training"]; reasoningEffort: CodexReasoningEffort; onPlanStarted: () => void }) {
  const [mergeIntoId, setMergeIntoId] = useState("");
  const mergeTargets = candidates.filter((item) => item.id !== candidate.id && item.status !== "retired");
  async function createPlan() {
    const creation = await training.actions.createCandidate(candidate.id, preferences.creationMode, trainingAuthoringModel(preferences, defaultModel), reasoningEffort);
    if (!creation) return;
    if (creation.state === "awaiting_disclosure_approval" && preferences.autoApproveEvidence) await training.actions.approveDisclosure(creation.id, true);
    onPlanStarted();
  }
  return <article className="training-card"><div className="training-card-heading"><strong>{candidate.title}</strong><span className="training-pill">{candidate.recommendation.tactic.replaceAll("_", " ")}</span></div><p>{candidate.summary}</p><dl><div><dt>Frequency</dt><dd>{percent(candidate.scorecard.frequency)}</dd></div><div><dt>Verifiable</dt><dd>{percent(candidate.scorecard.verifiability)}</dd></div><div><dt>Signal</dt><dd>{percent(candidate.scorecard.signalQuality)}</dd></div></dl><details className="training-evidence"><summary>Evidence and recommendation</summary><p>{candidate.recommendation.reasons.join(" ")}</p>{candidate.recommendation.blockers.map((blocker) => <p key={blocker} className="training-draft-warning">{blocker}</p>)}<ul>{candidate.evidence.map((item) => <li key={item.id}><strong>{item.kind.replaceAll("_", " ")}</strong> — {item.summary} ({percent(item.confidence)})</li>)}</ul></details><div className="training-inline-actions"><button className="training-button" disabled={Boolean(training.busyAction)} onClick={() => void createPlan()}>Create plan</button><button className="training-text-button" onClick={() => void training.actions.patchCandidate(candidate.id, { status: "rejected" })}>Reject</button><button className="training-text-button" onClick={() => void training.actions.patchCandidate(candidate.id, { status: "dismissed" })}>Dismiss</button></div>{mergeTargets.length ? <div className="training-merge-row"><select aria-label={`Merge ${candidate.title} into`} value={mergeIntoId} onChange={(event) => setMergeIntoId(event.target.value)}><option value="">Merge into…</option>{mergeTargets.map((target) => <option value={target.id} key={target.id}>{target.title}</option>)}</select><button className="training-text-button" disabled={!mergeIntoId} onClick={() => void training.actions.patchCandidate(candidate.id, { mergeIntoId })}>Merge</button></div> : null}</article>;
}

function EmptyDetail() { return <div className="training-empty-detail"><Play size={22} /><h2>No Tasksets yet</h2><p>Start a model to create one from selected chats.</p></div>; }
function label(value: MainTab) { return value[0]!.toUpperCase() + value.slice(1); }
function countFor(state: TrainingController["payload"]) { if (!state) return 0; return state.tasksets.length; }
function percent(value: number) { return `${Math.round(value * 100)}%`; }
