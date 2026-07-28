import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import type {
  ModelProject,
  ModelRunDraft,
  Taskset,
  TrainingDestinationId,
  TrainingRecipe,
} from "@openpond/contracts";
import type { ClientConnection } from "../../api";
import { ConfirmDialog, useConfirmDialog } from "../common/ConfirmDialog";
import type { DatasetEvidenceIntent } from "../training/TrainingGoalCards";
import type { TrainingWorkspaceProps } from "../training/training-workspace-types";
import type { TrainingStartApproval } from "../training/TrainingStartDialog";
import {
  ModelSetupConfigurationPreview,
  ModelSetupOverviewPreview,
  ModelSetupRunsPreview,
} from "./ModelRunSetupPreviews";
import type { ModelSetupStepId } from "./ModelSetupSteps";
import { ModelRunEditorHeader } from "./ModelRunEditorHeader";
import { ModelRunSetupContent } from "./ModelRunSetupContent";
import {
  bindTaskset,
  buildPageReason,
  cloneRunDraft,
  comparableEditor,
  firstIncompleteSetupStep,
  methodAvailability,
  newDraft,
  nextModelName,
  newProject,
  preparationReview,
} from "./model-run-editor-helpers";

export { nextModelName } from "./model-run-editor-helpers";

const SETUP_TABS = [
  ["setup", "Setup"],
  ["overview", "Overview"],
  ["runs", "Runs"],
  ["configuration", "Configuration"],
] as const;
type SetupTab = (typeof SETUP_TABS)[number][0];

export function ModelRunEditorPage({
  connection,
  initialObjective,
  initialModelId,
  initialName,
  initialDraftId,
  initialTasksetId,
  profileId,
  training,
  onCancel,
  onFinished,
  onNameChange,
  onSectionChange,
  onSaved,
  renderDatasetBuilder,
  onOpenProviderSettings,
}: {
  connection: ClientConnection | null;
  initialObjective: string | null;
  initialModelId?: string;
  initialName?: string;
  initialDraftId?: string;
  initialTasksetId?: string;
  profileId: string;
  training: TrainingWorkspaceProps["training"];
  onCancel: () => void;
  onFinished: (modelId: string, tasksetId: string) => Promise<void>;
  onNameChange?: (name: string) => void;
  onSectionChange?: (section: "run" | "dataset") => void;
  onSaved?: (modelId: string) => Promise<void> | void;
  renderDatasetBuilder: (
    onCreated: (tasksetId: string) => void,
    onUseExistingDataset: () => void,
    buildIntent: DatasetEvidenceIntent
  ) => ReactNode;
  onOpenProviderSettings?: () => void;
}) {
  const state = training.payload;
  const restoredDraft = useMemo(
    () =>
      state?.modelRunDrafts.find(
        (candidate) =>
          (candidate.status === "draft" ||
            candidate.status === "ready_to_run") &&
          candidate.id === initialDraftId
      ) ?? null,
    [initialDraftId, state?.modelRunDrafts]
  );
  const persistedProject =
    state?.modelProjects.find((candidate) => candidate.id === initialModelId) ??
    null;
  const initialTaskset =
    state?.tasksets.find((candidate) => candidate.id === initialTasksetId) ??
    null;
  const previousLaunchedDraft = useMemo(() => {
    if (!initialModelId || initialDraftId) return null;
    return [...(state?.modelRunDrafts ?? [])]
      .filter(
        (candidate) =>
          candidate.modelId === initialModelId &&
          candidate.status === "launched" &&
          state?.tasksets.some(
            (taskset) =>
              taskset.id === candidate.tasksetRef?.id &&
              taskset.revision === candidate.tasksetRef.revision &&
              taskset.contentHash === candidate.tasksetRef.contentHash
          )
      )
      .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))[0] ?? null;
  }, [initialDraftId, initialModelId, state?.modelRunDrafts, state?.tasksets]);
  const initialProjectRef = useRef<ModelProject | null>(null);
  if (!initialProjectRef.current) {
    initialProjectRef.current =
      persistedProject ??
      newProject(
        profileId,
        initialObjective,
        initialModelId,
        initialName ?? nextModelName(state?.modelProjects ?? [])
      );
  }
  const [project, setProject] = useState(initialProjectRef.current);
  const initialDraftRef = useRef<ModelRunDraft | null>(null);
  if (!initialDraftRef.current) {
    const baseDraft = restoredDraft
      ?? (previousLaunchedDraft
        ? cloneRunDraft(previousLaunchedDraft)
        : newDraft(profileId, initialProjectRef.current.id));
    initialDraftRef.current = initialTaskset
      ? bindTaskset(baseDraft, initialTaskset)
      : baseDraft;
  }
  const [draft, setDraft] = useState(initialDraftRef.current);
  const [activeSetupTab, setActiveSetupTab] = useState<SetupTab>("setup");
  const [activeSetupStep, setActiveSetupStep] = useState<ModelSetupStepId>(() =>
    firstIncompleteSetupStep(initialDraftRef.current!)
  );
  const [datasetBuilderOpen, setDatasetBuilderOpen] = useState(
    initialDraftRef.current.datasetMode === "build" &&
      !initialDraftRef.current.tasksetRef
  );
  const [savedSnapshot, setSavedSnapshot] = useState(
    restoredDraft && persistedProject
      ? comparableEditor(persistedProject, restoredDraft)
      : ""
  );
  const { confirmAction, confirmDialog, resolveConfirmDialog } =
    useConfirmDialog();
  const [launchState, setLaunchState] = useState<{
    ready: boolean;
    reason: string | null;
    actionLabel: string;
  }>({
    ready: false,
    reason: "Select a Taskset.",
    actionLabel: "Run",
  });
  const [runApproval, setRunApproval] = useState<TrainingStartApproval>({
    exportApproved: true,
    maximumCostUsd: 0,
    retentionDays: null,
    region: null,
  });
  const selectedTaskset =
    state?.tasksets.find(
      (taskset) =>
        taskset.id === draft.tasksetRef?.id &&
        taskset.revision === draft.tasksetRef.revision &&
        taskset.contentHash === draft.tasksetRef.contentHash
    ) ?? null;
  const methodCards = useMemo(
    () => methodAvailability(selectedTaskset, state?.destinations ?? []),
    [selectedTaskset, state?.destinations]
  );
  const dirty = comparableEditor(project, draft) !== savedSnapshot;
  const busy = Boolean(training.busyAction);
  const pageReason = buildPageReason(
    project,
    draft,
    selectedTaskset,
    launchState
  );
  const canRun = !busy && pageReason === null;

  useEffect(() => {
    onSectionChange?.(datasetBuilderOpen ? "dataset" : "run");
  }, [datasetBuilderOpen, onSectionChange]);

  useEffect(() => {
    onNameChange?.(project.name);
  }, [onNameChange, project.name]);

  useEffect(() => {
    if (!dirty) return undefined;
    const warn = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      event.returnValue = "";
    };
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [dirty]);

  useEffect(() => {
    if (!draft.method) return;
    const selectedMethod = methodCards.find(
      (candidate) => candidate.method === draft.method
    );
    if (selectedMethod?.available) return;
    setDraft((current) => ({
      ...current,
      method: null,
      recipe: null,
      runPreset: null,
      baseModel: null,
      destinationId: null,
      updatedAt: new Date().toISOString(),
    }));
  }, [draft.method, methodCards]);

  useEffect(() => {
    if (!draft.method || draft.runPreset) return;
    setDraft((current) => ({
      ...current,
      runPreset: "standard",
      updatedAt: new Date().toISOString(),
    }));
  }, [draft.method, draft.runPreset]);

  const updateConfiguration = useCallback(
    (configuration: {
      baseModel: ModelRunDraft["baseModel"];
      method: "sft" | "dpo" | "grpo" | "ppo";
      destinationId: TrainingDestinationId;
      recipe: TrainingRecipe;
      approval: TrainingStartApproval;
    }) => {
      setRunApproval(configuration.approval);
      setDraft((current) => ({
        ...current,
        baseModel: configuration.baseModel,
        // Method is chosen on the preceding step. An embedded configuration
        // instance may publish once while React is switching steps; never let
        // that stale publication replace the user's explicit card selection.
        method: current.method ?? configuration.method,
        destinationId: configuration.destinationId,
        recipe: configuration.recipe,
        updatedAt: new Date().toISOString(),
      }));
    },
    []
  );

  const updateLaunchState = useCallback(
    (next: typeof launchState) => setLaunchState(next),
    []
  );

  async function save(notifySaved = true): Promise<ModelRunDraft | null> {
    const timestamp = new Date().toISOString();
    const nextProject: ModelProject = {
      ...project,
      updatedAt: timestamp,
    };
    const savedProject = await training.actions.saveModelProject(nextProject);
    if (!savedProject) return null;
    const next: ModelRunDraft = {
      ...draft,
      status: pageReason === null ? "ready_to_run" : "draft",
      updatedAt: timestamp,
    };
    const saved = await training.actions.saveModelRunDraft(next);
    if (!saved) return null;
    setProject(savedProject);
    setDraft(saved);
    setSavedSnapshot(comparableEditor(savedProject, saved));
    if (notifySaved) await onSaved?.(saved.modelId);
    return saved;
  }

  async function cancel() {
    if (dirty) {
      const confirmed = await confirmAction({
        title: "Discard run setup?",
        body: "Your Model and run setup changes will be discarded.",
        confirmLabel: "Discard",
        cancelLabel: "Keep editing",
        tone: "danger",
      });
      if (!confirmed) return;
    }
    onCancel();
  }

  async function launch() {
    if (!canRun || !selectedTaskset) return;
    const saved = await save(false);
    if (!saved) return;
    const preparation = await training.actions.prepareModelRun(saved.id, {
      maximumSpendUsd: runApproval.maximumCostUsd,
      retentionDays: runApproval.retentionDays,
    });
    if (!preparation) return;
    const confirmed = await confirmAction({
      title: "Review and start training",
      body: preparationReview(preparation),
      confirmLabel: preparation.quoteUsd
        ? `Approve up to $${(
            preparation.maximumSpendUsd ?? preparation.quoteUsd
          ).toFixed(2)} and run`
        : "Start exact run",
      cancelLabel: "Back",
    });
    if (!confirmed) return;
    const started = await training.actions.startModelRun(saved.id, {
      maximumSpendUsd: runApproval.maximumCostUsd,
      retentionDays: runApproval.retentionDays,
    });
    if (!started) return;
    await onFinished(saved.modelId, selectedTaskset.id);
  }

  function selectTaskset(taskset: Taskset) {
    setDatasetBuilderOpen(false);
    setActiveSetupStep("method");
    setDraft((current) => ({
      ...current,
      datasetMode: "existing",
      tasksetRef: {
        id: taskset.id,
        revision: taskset.revision,
        contentHash: taskset.contentHash,
      },
      updatedAt: new Date().toISOString(),
    }));
  }

  if (datasetBuilderOpen && draft.buildIntent) {
    return (
      <main
        className="model-build-page model-build-dataset-page"
        aria-label="New Taskset"
      >
        <header className="model-build-header">
          <div>
            <h1>New Taskset</h1>
          </div>
          <button
            className="training-button secondary"
            type="button"
            onClick={() => {
              setDatasetBuilderOpen(false);
              setDraft((current) => ({
                ...current,
                datasetMode: null,
                updatedAt: new Date().toISOString(),
              }));
            }}
          >
            Back to run setup
          </button>
        </header>
        {renderDatasetBuilder(
          (tasksetId) => {
            const taskset = state?.tasksets.find(
              (candidate) => candidate.id === tasksetId
            );
            if (taskset) selectTaskset(taskset);
            else
              void training.refresh().then((next) => {
                const created = next?.tasksets.find(
                  (candidate) => candidate.id === tasksetId
                );
                if (created) selectTaskset(created);
              });
          },
          () => {
            setDatasetBuilderOpen(false);
            setDraft((current) => ({
              ...current,
              datasetMode: "existing",
              tasksetRef: null,
              updatedAt: new Date().toISOString(),
            }));
          },
          draft.buildIntent
        )}
      </main>
    );
  }

  return (
    <>
      <main className="model-build-page" aria-label="Run setup">
        <ModelRunEditorHeader
          project={project}
          persisted={Boolean(persistedProject)}
          busy={busy}
          dirty={dirty}
          canRun={canRun}
          pageReason={pageReason}
          actionLabel={launchState.actionLabel}
          onProjectChange={setProject}
          onCancel={() => void cancel()}
          onSave={() => void save()}
          onLaunch={() => void launch()}
        />

        <div
          className="training-detail-tabs model-setup-tabs"
          role="tablist"
          aria-label="Model creation"
        >
          {SETUP_TABS.map(([id, label]) => (
            <button
              aria-selected={activeSetupTab === id}
              className={activeSetupTab === id ? "active" : undefined}
              key={id}
              role="tab"
              type="button"
              onClick={() => setActiveSetupTab(id)}
            >
              {label}
            </button>
          ))}
        </div>

        {activeSetupTab === "setup" ? (
          <ModelRunSetupContent
            activeStep={activeSetupStep}
            onStepChange={setActiveSetupStep}
            draft={draft}
            setDraft={setDraft}
            selectedTaskset={selectedTaskset}
            methodCards={methodCards}
            tasksets={state?.tasksets ?? []}
            baseModelCandidates={state?.baseModelCandidates ?? []}
            destinations={state?.destinations ?? []}
            connection={connection}
            training={training}
            canRun={canRun}
            onSelectTaskset={selectTaskset}
            onOpenDatasetBuilder={() => {
              setDraft((current) => ({
                ...current,
                datasetMode: "build",
                tasksetRef: null,
                updatedAt: new Date().toISOString(),
              }));
              setDatasetBuilderOpen(true);
            }}
            onLaunchStateChange={updateLaunchState}
            onConfigurationChange={updateConfiguration}
            onOpenProviderSettings={onOpenProviderSettings}
            onFinished={onFinished}
          />
        ) : activeSetupTab === "overview" ? (
          <ModelSetupOverviewPreview
            project={project}
            draft={draft}
            taskset={selectedTaskset}
          />
        ) : activeSetupTab === "runs" ? (
          <ModelSetupRunsPreview
            project={project}
            draft={draft}
            taskset={selectedTaskset}
          />
        ) : (
          <ModelSetupConfigurationPreview
            project={project}
            draft={draft}
            taskset={selectedTaskset}
          />
        )}
      </main>
      <ConfirmDialog state={confirmDialog} onResolve={resolveConfirmDialog} />
    </>
  );
}
