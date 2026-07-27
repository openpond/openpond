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
  ModelRunPreset,
  Taskset,
  TrainingDestinationId,
  TrainingRecipe,
} from "@openpond/contracts";
import type { ClientConnection } from "../../api";
import { ConfirmDialog, useConfirmDialog } from "../common/ConfirmDialog";
import {
  TrainingGoalCards,
  type DatasetEvidenceIntent,
} from "../training/TrainingGoalCards";
import type { TrainingViewProps } from "../training/TrainingView";
import {
  TrainingStartDialog,
  type TrainingStartApproval,
} from "../training/TrainingStartDialog";
import {
  ModelSetupConfigurationPreview,
  ModelSetupOverviewPreview,
  ModelSetupRunsPreview,
} from "./ModelRunSetupPreviews";
import {
  MODEL_SETUP_STEPS,
  ModelSetupSteps,
  type ModelSetupStepId,
} from "./ModelSetupSteps";
import {
  bindTaskset,
  buildPageReason,
  cloneRunDraft,
  comparableEditor,
  datasetGuidance,
  firstIncompleteSetupStep,
  methodAvailability,
  newDraft,
  nextModelName,
  newProject,
  preparationReview,
  presetFor,
  presetsFor,
  setupStepComplete,
} from "./model-run-editor-helpers";

export { nextModelName } from "./model-run-editor-helpers";

const RUN_CONTROL_ID = "model-build-run-control";
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
  training: TrainingViewProps["training"];
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
  const [editingName, setEditingName] = useState(false);
  const nameBeforeEditRef = useRef(initialProjectRef.current.name);
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

  const datasetStepContent = (
    <div className="model-build-existing-dataset">
      <label className="model-build-field">
        <span>Taskset revision</span>
        <select
          aria-label="Taskset revision"
          value={selectedTaskset?.id ?? ""}
          onChange={(event) => {
            const taskset = state?.tasksets.find(
              (candidate) => candidate.id === event.target.value
            );
            if (taskset) selectTaskset(taskset);
          }}
        >
          <option value="">
            {state?.tasksets.length ? "Select a Taskset" : "No Tasksets yet"}
          </option>
          {state?.tasksets.map((taskset) => (
            <option
              key={`${taskset.id}:${taskset.revision}`}
              value={taskset.id}
            >
              {taskset.name} · r{taskset.revision} ·{" "}
              {taskset.readiness?.ready ? "ready" : "needs work"}
            </option>
          ))}
        </select>
      </label>
      <button
        className="training-button secondary"
        type="button"
        disabled={!draft.buildIntent}
        title={
          draft.buildIntent
            ? undefined
            : "Choose a goal before building a Taskset."
        }
        onClick={() => {
          setDraft((current) => ({
            ...current,
            datasetMode: "build",
            tasksetRef: null,
            updatedAt: new Date().toISOString(),
          }));
          setDatasetBuilderOpen(true);
        }}
      >
        {draft.datasetMode === "build"
          ? "Continue building Taskset"
          : "Build a Taskset"}
      </button>
    </div>
  );

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
        <header className="model-build-header">
          <div>
            {persistedProject ? (
              <>
                <h1 className="model-build-name">New run</h1>
                <p>{project.name}</p>
              </>
            ) : (
              <>
                {editingName ? (
                  <input
                    aria-label="Model name"
                    autoFocus
                    className="model-build-name model-build-name-input"
                    value={project.name}
                    onBlur={() => {
                      setProject((current) => ({
                        ...current,
                        name: current.name.trim() || nameBeforeEditRef.current,
                        updatedAt: new Date().toISOString(),
                      }));
                      setEditingName(false);
                    }}
                    onChange={(event) =>
                      setProject((current) => ({
                        ...current,
                        name: event.target.value,
                        updatedAt: new Date().toISOString(),
                      }))
                    }
                    onKeyDown={(event) => {
                      if (event.key === "Enter") event.currentTarget.blur();
                      if (event.key === "Escape") {
                        setProject((current) => ({
                          ...current,
                          name: nameBeforeEditRef.current,
                          updatedAt: new Date().toISOString(),
                        }));
                        setEditingName(false);
                      }
                    }}
                  />
                ) : (
                  <button
                    aria-label={`Rename ${project.name}`}
                    className="model-build-name model-build-name-button"
                    type="button"
                    onClick={() => {
                      nameBeforeEditRef.current = project.name;
                      setEditingName(true);
                    }}
                  >
                    {project.name}
                  </button>
                )}
              </>
            )}
          </div>
          <div className="model-build-actions">
            <button
              id="model-run-editor-cancel"
              className="training-button secondary"
              type="button"
              disabled={busy}
              onClick={() => void cancel()}
            >
              Cancel
            </button>
            <button
              className="training-button secondary"
              type="button"
              disabled={busy || !dirty || !project.name.trim()}
              onClick={() => void save()}
            >
              Save
            </button>
            <span
              className="model-build-run-control"
              title={pageReason ?? launchState.actionLabel}
            >
              <button
                className="training-button"
                type="button"
                disabled={!canRun}
                onClick={() => void launch()}
              >
                {launchState.actionLabel}
              </button>
            </span>
          </div>
        </header>

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
          <>
            <ModelSetupSteps
              activeStep={activeSetupStep}
              steps={MODEL_SETUP_STEPS.map((step) => ({
                ...step,
                complete: setupStepComplete(
                  step.id,
                  draft,
                  selectedTaskset,
                  canRun
                ),
              }))}
              onStepChange={setActiveSetupStep}
            />

            {activeSetupStep === "goal" ? (
              <section className="model-build-section">
                <div className="model-build-section-heading">
                  <h2>What do you want to build?</h2>
                </div>
                <TrainingGoalCards
                  value={draft.buildIntent}
                  onChange={(buildIntent) => {
                    setDraft((current) => ({
                      ...current,
                      buildIntent,
                      buildSpecification:
                        current.buildSpecification?.kind === buildIntent
                          ? current.buildSpecification
                          : null,
                      updatedAt: new Date().toISOString(),
                    }));
                    setActiveSetupStep("dataset");
                  }}
                />
              </section>
            ) : activeSetupStep === "dataset" ? (
              <section className="model-build-section">
                <div className="model-build-section-heading">
                  <div>
                    <h2>Choose or build a Taskset</h2>
                    <p>{datasetGuidance(draft.buildIntent)}</p>
                  </div>
                </div>
                <div className="model-build-dataset-step">
                  {datasetStepContent}
                </div>
              </section>
            ) : activeSetupStep === "method" ? (
              <section className="model-build-section">
                <div className="model-build-section-heading">
                  <h2>Choose a training method</h2>
                </div>
                <div className="model-build-method-grid">
                  {methodCards.map((candidate) => (
                    <button
                      className={
                        draft.method === candidate.method
                          ? "model-build-method selected"
                          : "model-build-method"
                      }
                      key={candidate.method}
                      type="button"
                      disabled={!candidate.available}
                      title={candidate.available ? undefined : candidate.reason}
                      onClick={() => {
                        setDraft((current) => ({
                          ...current,
                          method: candidate.method,
                          runPreset: "standard",
                          recipe: null,
                          updatedAt: new Date().toISOString(),
                        }));
                        setActiveSetupStep("configuration");
                      }}
                    >
                      <span>
                        <strong>{candidate.method.toUpperCase()}</strong>
                        <em>{candidate.state}</em>
                      </span>
                      <small>{candidate.reason}</small>
                      <span
                        className="model-build-method-targets"
                        aria-label="Execution targets"
                      >
                        {candidate.executionTargets.map((target) => (
                          <span
                            aria-label={`${target.label}: ${
                              target.available
                                ? "available"
                                : target.reason
                            }`}
                            className={
                              target.available
                                ? "model-build-target-pill available"
                                : "model-build-target-pill unavailable"
                            }
                            key={target.id}
                            title={
                              target.available ? undefined : target.reason
                            }
                          >
                            {target.label}
                          </span>
                        ))}
                      </span>
                      <span
                        className="training-choice-indicator"
                        aria-hidden="true"
                      />
                    </button>
                  ))}
                </div>
              </section>
            ) : (
              <section className="model-build-section">
                <div className="model-build-section-heading">
                  <div>
                    <h2>Choose a model</h2>
                    <p>Select the starting model and where it will train.</p>
                  </div>
                </div>
                {selectedTaskset &&
                (draft.method === "sft" ||
                  draft.method === "dpo" ||
                  draft.method === "grpo" ||
                  draft.method === "ppo") ? (
                  <TrainingStartDialog
                    key={`${selectedTaskset.id}:${selectedTaskset.revision}:${draft.method}:${draft.runPreset}`}
                    baseModelCandidates={state?.baseModelCandidates ?? []}
                    connection={connection}
                    taskset={selectedTaskset}
                    modelId={draft.modelId}
                    destinations={state?.destinations ?? []}
                    initialMethod={draft.method}
                    preferredBaseModel={draft.baseModel}
                    busy={[
                      "baseline",
                      "prepare-training",
                      "prepare-model-run",
                      "start-prepared-training",
                      "start-training",
                      "start-model-run",
                    ].includes(training.busyAction ?? "")}
                    busyAction={training.busyAction}
                    baselineReports={
                      state?.baselineReports.filter(
                        (report) =>
                          report.tasksetId === selectedTaskset.id &&
                          report.tasksetHash === selectedTaskset.contentHash
                      ) ?? []
                    }
                    baselineRuns={
                      state?.baselineRuns.filter(
                        (run) => run.tasksetId === selectedTaskset.id
                      ) ?? []
                    }
                    presentation="embedded"
                    hideActions
                    runControlId={RUN_CONTROL_ID}
                    runPreset={draft.runPreset ?? "standard"}
                    hideMethodTabs
                    approvalPresentation="dialog"
                    configurationContent={
                      <details className="model-run-options">
                        <summary>
                          <span>Training configuration</span>
                          <strong>
                            {presetFor(draft.method, draft.runPreset)?.label ??
                              "Recommended"}
                          </strong>
                        </summary>
                        <label className="model-build-field">
                          <span>Training budget</span>
                          <select
                            aria-label="Training budget"
                            value={draft.runPreset ?? "standard"}
                            onChange={(event) =>
                              setDraft((current) => ({
                                ...current,
                                runPreset: event.target
                                  .value as ModelRunPreset,
                                recipe: null,
                                updatedAt: new Date().toISOString(),
                              }))
                            }
                          >
                            {presetsFor(draft.method).map((preset) => (
                              <option key={preset.id} value={preset.id}>
                                {preset.label}
                              </option>
                            ))}
                          </select>
                          <small>
                            {presetFor(draft.method, draft.runPreset)
                              ?.description ??
                              "Use Taskset-aware recommended limits."}
                          </small>
                        </label>
                      </details>
                    }
                    onReadinessChange={updateLaunchState}
                    onConfigurationChange={updateConfiguration}
                    onClose={() => undefined}
                    onOpenProviderSettings={onOpenProviderSettings}
                    onRunBaseline={async (model, options) =>
                      Boolean(
                        await training.actions.baseline(
                          selectedTaskset.id,
                          model,
                          options
                        )
                      )
                    }
                    onPrepare={(destinationId, recipe, approval) =>
                      training.actions.prepareTraining({
                        modelId: draft.modelId,
                        tasksetId: selectedTaskset.id,
                        destinationId,
                        recipe,
                        exportApproved: approval.exportApproved,
                        retentionDays: approval.retentionDays,
                        region: approval.region,
                      })
                    }
                    onConfirmPrepared={async (prepared, maximumCostUsd) => {
                      const started =
                        await training.actions.startPreparedTraining({
                          planId: prepared.plan.id,
                          bundleId: prepared.bundle.id,
                          maximumCostUsd,
                        });
                      if (!started) return false;
                      await training.actions.saveModelRunDraft({
                        ...draft,
                        status: "launched",
                        updatedAt: new Date().toISOString(),
                      });
                      await onFinished(draft.modelId, selectedTaskset.id);
                      return true;
                    }}
                    onStart={async (
                      destinationId,
                      recipe,
                      approval: TrainingStartApproval
                    ) => {
                      const started = await training.actions.startTraining({
                        modelId: draft.modelId,
                        tasksetId: selectedTaskset.id,
                        destinationId,
                        recipe,
                        ...approval,
                      });
                      if (!started) return false;
                      await training.actions.saveModelRunDraft({
                        ...draft,
                        status: "launched",
                        updatedAt: new Date().toISOString(),
                      });
                      await onFinished(draft.modelId, selectedTaskset.id);
                      return true;
                    }}
                  />
                ) : (
                  <div className="model-build-empty">
                    Choose a Taskset and training method to select a model.
                  </div>
                )}
              </section>
            )}
          </>
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
