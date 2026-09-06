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
  LearnedPreferenceRewardBinding,
  Taskset,
  TrainingDestinationId,
  TrainingRecipe,
} from "@openpond/contracts";
import type { ClientConnection } from "../../api";
import { ConfirmDialog, useConfirmDialog } from "../common/ConfirmDialog";
import type { TrainingWorkspaceProps } from "../training/training-workspace-types";
import type { TrainingStartApproval } from "../training/TrainingStartDialog";
import type { ModelSetupStepId } from "./ModelSetupSteps";
import { ModelRunEditorHeader } from "./ModelRunEditorHeader";
import { ModelRunSetupContent } from "./ModelRunSetupContent";
import { labModelTasksets } from "./lab-models";
import { useDraftNavigation } from "./useDraftNavigation";
import {
  bindTaskset,
  buildPageReason,
  comparableEditor,
  firstIncompleteSetupStep,
  methodAvailability,
  nextModelName,
  newProject,
  preparationReview,
  projectEditorState,
  type ModelProjectEditorState,
} from "./model-run-editor-helpers";

export { nextModelName } from "./model-run-editor-helpers";

export function ModelRunEditorPage({
  connection,
  initialObjective,
  initialModelId,
  initialName,
  initialTasksetId,
  initialLearnedPreferenceReward = null,
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
  initialTasksetId?: string;
  initialLearnedPreferenceReward?: LearnedPreferenceRewardBinding | null;
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
  ) => ReactNode;
  onOpenProviderSettings?: () => void;
}) {
  const state = training.payload;
  const availableTasksets = useMemo(() => {
    const tasksets = labModelTasksets(state);
    const project = initialModelId
      ? state?.modelProjects.find((candidate) => candidate.id === initialModelId)
      : null;
    if (!project) return tasksets;
    const attachedIds = new Set(
      project.tasksetSyncs.map((sync) => sync.localTasksetId),
    );
    if (project.trainingSetup.tasksetRef) attachedIds.add(project.trainingSetup.tasksetRef.id);
    if (initialTasksetId) attachedIds.add(initialTasksetId);
    return tasksets.filter((taskset) => attachedIds.has(taskset.id));
  }, [initialModelId, initialTasksetId, state]);
  const persistedProject =
    state?.modelProjects.find((candidate) => candidate.id === initialModelId) ??
    null;
  const initialTaskset =
    availableTasksets.find((candidate) => candidate.id === initialTasksetId) ??
    availableTasksets.find(
      (candidate) =>
        candidate.id === persistedProject?.trainingSetup.tasksetRef?.id &&
        candidate.revision === persistedProject.trainingSetup.tasksetRef.revision &&
        candidate.contentHash ===
          persistedProject.trainingSetup.tasksetRef.contentHash,
    ) ??
    availableTasksets[0] ??
    null;
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
  const [savedRevision, setSavedRevision] = useState(persistedProject?.revision ?? 0);
  const initialSetupRef = useRef<ModelProjectEditorState | null>(null);
  if (!initialSetupRef.current) {
    const current = projectEditorState(initialProjectRef.current);
    initialSetupRef.current = initialTaskset
      ? bindTaskset(current, initialTaskset)
      : current;
  }
  const [setup, setSetup] = useState(initialSetupRef.current);
  const [activeSetupStep, setActiveSetupStep] = useState<ModelSetupStepId>(() =>
    firstIncompleteSetupStep(initialSetupRef.current!)
  );
  const [datasetBuilderOpen, setDatasetBuilderOpen] = useState(false);
  const [savedSnapshot, setSavedSnapshot] = useState(
    persistedProject
      ? comparableEditor(persistedProject, projectEditorState(persistedProject))
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
    maximumCostUsd:
      initialProjectRef.current.trainingSetup.preferredMaximumSpendUsd ?? 0,
    retentionDays:
      initialProjectRef.current.trainingSetup.preferredRetentionDays,
    region: null,
  });
  const [savedApproval, setSavedApproval] = useState(() => JSON.stringify(runApproval));
  const selectedTaskset =
    availableTasksets.find(
      (taskset) =>
        taskset.id === setup.tasksetRef?.id &&
        taskset.revision === setup.tasksetRef.revision &&
        taskset.contentHash === setup.tasksetRef.contentHash
    ) ?? null;
  const methodCards = useMemo(
    () => methodAvailability(selectedTaskset, state?.destinations ?? []),
    [selectedTaskset, state?.destinations]
  );
  const dirty = comparableEditor(project, setup) !== savedSnapshot || JSON.stringify(runApproval) !== savedApproval;
  const busy = Boolean(training.busyAction);
  const pageReason = buildPageReason(
    project,
    setup,
    selectedTaskset,
    launchState
  );
  const canRun = !busy && pageReason === null;
  const draftNavigation = useDraftNavigation({ dirty, busy, name: "run setup", save: async () => Boolean(await save(false)) });

  useEffect(() => {
    onSectionChange?.(datasetBuilderOpen ? "dataset" : "run");
  }, [datasetBuilderOpen, onSectionChange]);

  useEffect(() => {
    onNameChange?.(project.name);
  }, [onNameChange, project.name]);

  useEffect(() => {
    if (!setup.method) return;
    const selectedMethod = methodCards.find(
      (candidate) => candidate.method === setup.method
    );
    if (selectedMethod?.available) return;
    setSetup((current) => ({
      ...current,
      method: null,
      recipe: null,
      runPreset: null,
      baseModel: null,
      destinationId: null,
      updatedAt: new Date().toISOString(),
    }));
  }, [setup.method, methodCards]);

  useEffect(() => {
    if (!setup.method || setup.runPreset) return;
    setSetup((current) => ({
      ...current,
      runPreset: "standard",
      updatedAt: new Date().toISOString(),
    }));
  }, [setup.method, setup.runPreset]);

  const updateConfiguration = useCallback(
    (configuration: {
      baseModel: ModelProjectEditorState["baseModel"];
      method: "sft" | "dpo" | "grpo" | "ppo";
      destinationId: TrainingDestinationId;
      recipe: TrainingRecipe;
      approval: TrainingStartApproval;
    }) => {
      setRunApproval(configuration.approval);
      setSetup((current) => ({
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

  async function save(notifySaved = true): Promise<ModelProject | null> {
    const timestamp = new Date().toISOString();
    const {
      projectId: _projectId,
      datasetMode: _datasetMode,
      updatedAt: _setupUpdatedAt,
      ...trainingSetup
    } = setup;
    const nextProject: ModelProject = {
      ...project,
      trainingSetup: {
        ...trainingSetup,
        preferredMaximumSpendUsd: runApproval.maximumCostUsd,
        preferredRetentionDays: runApproval.retentionDays,
      },
      updatedAt: timestamp,
    };
    const savedProject = await training.actions.saveModelProject(nextProject, savedRevision);
    if (!savedProject) return null;
    setProject(savedProject);
    setSavedRevision(savedProject.revision);
    const savedSetup = projectEditorState(savedProject);
    setSetup(savedSetup);
    setSavedSnapshot(comparableEditor(savedProject, savedSetup));
    setSavedApproval(JSON.stringify(runApproval));
    if (notifySaved && onSaved) { draftNavigation.allowNextNavigation(); await onSaved(savedProject.id); }
    return savedProject;
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
    draftNavigation.allowNextNavigation();
    onCancel();
  }

  async function launch() {
    if (!canRun || !selectedTaskset) return;
    // The final review is the explicit authorization for this bounded
    // Taskset export. The embedded provider form may not be opened when the
    // backend reports no quoted spend, but the managed endpoint still records
    // that authorization.
    const approvedRun = { ...runApproval, exportApproved: true };
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
      maximumSpendUsd: approvedRun.maximumCostUsd,
      retentionDays: approvedRun.retentionDays,
      exportApproved: approvedRun.exportApproved,
    });
    if (!started) return;
    draftNavigation.allowNextNavigation();
    await onFinished(saved.id, selectedTaskset.id);
  }

  function selectTaskset(taskset: Taskset) {
    setDatasetBuilderOpen(false);
    setActiveSetupStep("method");
    setSetup((current) => bindTaskset(current, taskset));
  }

  if (datasetBuilderOpen) {
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
              setSetup((current) => ({
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
            const taskset = availableTasksets.find(
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
            setSetup((current) => ({
              ...current,
              datasetMode: "existing",
              tasksetRef: null,
              updatedAt: new Date().toISOString(),
            }));
          }
        )}
        {draftNavigation.dialog}
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

        <ModelRunSetupContent
          activeStep={activeSetupStep}
          onStepChange={setActiveSetupStep}
          setup={setup}
          learnedPreferenceReward={initialLearnedPreferenceReward}
          setSetup={setSetup}
          selectedTaskset={selectedTaskset}
          methodCards={methodCards}
          tasksets={availableTasksets}
          baseModelCandidates={state?.baseModelCandidates ?? []}
          destinations={state?.destinations ?? []}
          connection={connection}
          training={training}
          canRun={canRun}
          onSelectTaskset={selectTaskset}
          onOpenDatasetBuilder={() => {
            setSetup((current) => ({
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
      </main>
      <ConfirmDialog state={confirmDialog} onResolve={resolveConfirmDialog} />
      {draftNavigation.dialog}
    </>
  );
}
