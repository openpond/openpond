import { useEffect, useState } from "react";
import type { AppPreferences, ChatModelRef, CodexReasoningEffort, LocalProject, ProviderSettings, Session, TaskCreationSnapshot, Taskset } from "@openpond/contracts";
import type { ClientConnection, PreferencesPayload } from "../../api";
import type { ShowAppToast } from "../../app/app-state";
import type { useTraining } from "../../hooks/useTraining";
import type { TrainingModelChatHandoff } from "../../lib/training-model-chat-handoff";
import { CircleAlert, Loader2, Play, RefreshCw, Settings } from "../icons";
import { TrainingTasksetDetail } from "./TrainingTasksetDetail";
import { TrainingModels } from "./TrainingModels";
import { TrainingSuggestions } from "./TrainingSuggestions";
import { TrainingCreationPanel } from "./TrainingCreationPanel";
import { CreateImproveAuthoringDialog } from "../create-improve/CreateImproveAuthoringDialog";
import { TrainingSettingsDialog } from "./TrainingSettingsDialog";
import "../../styles/training/training.css";

type TrainingController = ReturnType<typeof useTraining>;
export type TrainingSection = "models" | "evals" | "suggestions";
export type TrainingLaunchRequest = { id: number; objective: string | null; initialSessionIds?: string[] };

export type TrainingViewProps = {
  section?: TrainingSection;
  onSectionChange?: (section: "models" | "evals") => void;
  training: TrainingController;
  sessions: Session[];
  localProjects?: LocalProject[];
  connection: ClientConnection | null;
  defaultModel: ChatModelRef;
  onError: (message: string | null) => void;
  onToast: ShowAppToast;
  onSettingsPreferences: (payload: PreferencesPayload) => void;
  onOpenChat: (sessionId: string) => void;
  onChatWithModel: (handoff: TrainingModelChatHandoff) => void;
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
};

export function TrainingView({
  section = "models",
  onSectionChange,
  training,
  sessions,
  localProjects = [],
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
}: TrainingViewProps) {
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
      onSectionChange?.("models");
    }
    if (launchRequest) onLaunchHandled(launchRequest.id);
  }

  function finishExistingDatasetModel(taskset: Taskset) {
    setRunDialogOpen(false);
    onSelectedTasksetIdChange(taskset.id);
    onDetailTasksetIdChange(taskset.id);
    onSectionChange?.("models");
    if (launchRequest) onLaunchHandled(launchRequest.id);
  }

  return (
    <section className="training-view" aria-label={trainingSectionLabel(section)}>
      <div className="training-header actions-only">
        <div className="training-header-actions">
          <button className="training-icon-button" type="button" aria-label="Refresh training" title="Refresh" disabled={training.loading} onClick={() => void training.refresh()}>
            <RefreshCw className={training.loading ? "spin" : undefined} size={15} />
          </button>
          <button className="training-button secondary" type="button" onClick={() => setSettingsDialogOpen(true)}>
            <Settings size={14} /> Settings
          </button>
        </div>
      </div>

      {training.error ? <div className="training-banner error"><CircleAlert size={15} />{training.error}</div> : null}
      {training.busyAction ? <div className="training-banner"><Loader2 className="spin" size={15} />Working on {training.busyAction.replaceAll("-", " ")}…</div> : null}

      {section === "suggestions" ? (
        <TrainingSuggestions
          training={training}
          defaultModel={defaultModel}
          preferences={preferences}
          reasoningEffort={reasoningEffort}
          onPlanStarted={() => { onDetailTasksetIdChange(null); onSectionChange?.("evals"); }}
        />
      ) : section === "models" ? (
        <TrainingModels
          training={training}
          connection={connection}
          onOpenTasksetFiles={(tasksetId) => { onSelectedTasksetIdChange(tasksetId); onOpenTasksetFiles(); }}
          onOpenTaskset={(tasksetId) => { onSelectedTasksetIdChange(tasksetId); onDetailTasksetIdChange(null); onSectionChange?.("evals"); }}
          onSelectedTasksetIdChange={onSelectedTasksetIdChange}
          onSelectedJobIdChange={onSelectedTrainingJobIdChange}
          onChatWithModel={onChatWithModel}
          onToast={onToast}
          detailTasksetId={detailTasksetId}
          onDetailTasksetIdChange={onDetailTasksetIdChange}
        />
      ) : section === "evals" ? (
        <TrainingTasksets
          onOpenChat={onOpenChat}
          selectedTaskset={selectedTaskset}
          selectedTasksetId={selectedTaskset?.id ?? null}
          setSelectedTasksetId={onSelectedTasksetIdChange}
          training={training}
        />
      ) : null}

      {runDialogOpen && state ? (
        <CreateImproveAuthoringDialog
          defaultModel={defaultModel}
          initialObjective={launchRequest?.objective ?? null}
          initialSessionIds={launchRequest?.initialSessionIds ?? []}
          onClose={closeRunDialog}
          onModelCreatedFromTaskset={finishExistingDatasetModel}
          onTasksetCreated={finishTasksetCreation}
          preferences={preferences}
          providerSettings={providerSettings}
          reasoningEffort={reasoningEffort}
          localProjects={localProjects}
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

function EmptyDetail() { return <div className="training-empty-detail"><Play size={22} /><h2>No Tasksets yet</h2><p>Start a model to create one from selected chats.</p></div>; }
function trainingSectionLabel(section: TrainingSection): string {
  if (section === "evals") return "Evals";
  if (section === "suggestions") return "AI Suggestions";
  return "Models";
}
