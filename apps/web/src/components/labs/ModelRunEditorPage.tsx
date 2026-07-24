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
  TrainingMethod,
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

const RUN_CONTROL_ID = "model-build-run-control";
const METHODS = ["sft", "dpo", "grpo", "ppo"] as const;
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
    reason: "Select a Dataset.",
    actionLabel: "Run",
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
    }) => {
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
    await save(false);
    document.getElementById(RUN_CONTROL_ID)?.click();
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
        <span>Dataset revision</span>
        <select
          aria-label="Dataset revision"
          value={selectedTaskset?.id ?? ""}
          onChange={(event) => {
            const taskset = state?.tasksets.find(
              (candidate) => candidate.id === event.target.value
            );
            if (taskset) selectTaskset(taskset);
          }}
        >
          <option value="">
            {state?.tasksets.length ? "Select a Dataset" : "No Datasets yet"}
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
            : "Choose a goal before building a Dataset."
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
          ? "Continue building Dataset"
          : "Build a Dataset"}
      </button>
    </div>
  );

  if (datasetBuilderOpen && draft.buildIntent) {
    return (
      <main
        className="model-build-page model-build-dataset-page"
        aria-label="New Dataset"
      >
        <header className="model-build-header">
          <div>
            <h1>New Dataset</h1>
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
                    <h2>Choose or build a Dataset</h2>
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
                      "start-prepared-training",
                      "start-training",
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
                              "Use Dataset-aware recommended limits."}
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
                    Choose a Dataset and training method to select a model.
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

function newProject(
  profileId: string,
  objective: string | null,
  modelId?: string,
  name?: string
): ModelProject {
  const timestamp = new Date().toISOString();
  const suffix = crypto.randomUUID();
  return {
    schemaVersion: "openpond.modelProject.v1",
    id: modelId ?? `model_${suffix}`,
    profileId,
    name: name?.trim() || "Model #1",
    objective,
    defaultBaseModel: null,
    defaultDestinationId: null,
    createdAt: timestamp,
    updatedAt: timestamp,
  };
}

function firstIncompleteSetupStep(draft: ModelRunDraft): ModelSetupStepId {
  if (!draft.buildIntent) return "goal";
  if (!draft.tasksetRef) return "dataset";
  if (!draft.method) return "method";
  return "configuration";
}

function setupStepComplete(
  step: ModelSetupStepId,
  draft: ModelRunDraft,
  taskset: Taskset | null,
  canRun: boolean
): boolean {
  if (step === "goal") return Boolean(draft.buildIntent);
  if (step === "dataset") return Boolean(taskset);
  if (step === "method") return Boolean(draft.method);
  return canRun;
}

export function nextModelName(
  projects: Array<Pick<ModelProject, "name">>
): string {
  let highestNumber = projects.length;
  for (const project of projects) {
    const match = /^Model #(\d+)$/.exec(project.name.trim());
    if (match) highestNumber = Math.max(highestNumber, Number(match[1]));
  }
  return `Model #${highestNumber + 1}`;
}

function newDraft(profileId: string, modelId: string): ModelRunDraft {
  const timestamp = new Date().toISOString();
  const suffix = crypto.randomUUID();
  return {
    schemaVersion: "openpond.modelRunDraft.v1",
    id: `run_draft_${suffix}`,
    profileId,
    modelId,
    status: "draft",
    title: "Run draft",
    datasetMode: null,
    tasksetRef: null,
    datasetCreationId: null,
    buildIntent: null,
    buildSpecification: null,
    baseModel: null,
    method: null,
    destinationId: null,
    runPreset: null,
    recipe: null,
    createdAt: timestamp,
    updatedAt: timestamp,
  };
}

function bindTaskset(draft: ModelRunDraft, taskset: Taskset): ModelRunDraft {
  return {
    ...draft,
    datasetMode: "existing",
    tasksetRef: {
      id: taskset.id,
      revision: taskset.revision,
      contentHash: taskset.contentHash,
    },
    buildIntent: draft.buildIntent ?? buildIntentForTaskset(taskset),
    updatedAt: new Date().toISOString(),
  };
}

function cloneRunDraft(template: ModelRunDraft): ModelRunDraft {
  const timestamp = new Date().toISOString();
  return {
    ...template,
    id: `run_draft_${crypto.randomUUID()}`,
    status: "draft",
    title: "Run draft",
    createdAt: timestamp,
    updatedAt: timestamp,
  };
}

function buildIntentForTaskset(taskset: Taskset): DatasetEvidenceIntent {
  if (
    taskset.capabilities.supportedSignals.includes("preference") ||
    taskset.capabilities.compatibleMethods.includes("dpo")
  ) {
    return "preferences";
  }
  if (
    taskset.capabilities.supportedSignals.includes("reward") ||
    taskset.capabilities.compatibleMethods.includes("grpo") ||
    taskset.capabilities.compatibleMethods.includes("ppo")
  ) {
    return "verifiable_reward";
  }
  if (taskset.capabilities.supportedSignals.includes("label")) return "rubric";
  return "demonstrations";
}

function comparableEditor(project: ModelProject, draft: ModelRunDraft): string {
  const { updatedAt: _projectUpdatedAt, ...projectValue } = project;
  const { updatedAt: _draftUpdatedAt, status: _status, ...draftValue } = draft;
  return JSON.stringify({ project: projectValue, draft: draftValue });
}

function buildPageReason(
  project: ModelProject,
  draft: ModelRunDraft,
  taskset: Taskset | null,
  launchState: { ready: boolean; reason: string | null }
): string | null {
  if (!project.name.trim()) return "Name this Model.";
  if (!draft.buildIntent) return "Choose what you want to build.";
  if (!draft.datasetMode)
    return "Choose an existing Dataset or build a new one.";
  if (!taskset) return "Choose or build a Dataset to enable Run.";
  if (!draft.method) return "Choose a training method.";
  const readiness = taskset.readiness?.methodReadiness.find(
    (item) => item.method === draft.method
  );
  if (readiness?.status === "needs_dataset_work") {
    return readiness.reasons[0] ?? "Resolve Dataset readiness for this method.";
  }
  if (!draft.runPreset)
    return draft.method === "grpo" || draft.method === "ppo"
      ? "Choose an experiment size."
      : "Choose a run size.";
  if (!draft.baseModel) return "Choose a base model.";
  if (!draft.destinationId) return "Choose a compatible destination.";
  return launchState.ready
    ? null
    : launchState.reason ?? "Complete the launch checks.";
}

function methodAvailability(
  taskset: Taskset | null,
  destinations: NonNullable<
    TrainingViewProps["training"]["payload"]
  >["destinations"]
) {
  return METHODS.map((method) => {
    const readiness = taskset?.readiness?.methodReadiness.find(
      (item) => item.method === method
    );
    const datasetCompatible = Boolean(
      taskset &&
        (taskset.capabilities.compatibleMethods.includes(method) ||
          taskset.readiness?.trainingPath?.bootstrap?.method === method)
    );
    const executable = destinations.some(
      (destination) =>
        destination.available && destination.methods.includes(method)
    );
    const state =
      readiness?.status === "needs_dataset_work"
        ? "Needs Dataset work"
        : !datasetCompatible
        ? "Incompatible Dataset"
        : !executable
        ? "Destination unavailable"
        : readiness?.status === "recommended"
        ? "Recommended"
        : "Compatible";
    const reason =
      readiness?.reasons[0] ??
      (!datasetCompatible
        ? `This Dataset revision does not contain the evidence required for ${method.toUpperCase()}.`
        : !executable
        ? `No configured destination currently executes ${method.toUpperCase()}.`
        : methodTradeoff(method));
    const executionTargets = methodExecutionTargets(method, destinations);
    return {
      method,
      state,
      reason,
      executionTargets,
      available: datasetCompatible &&
        readiness?.status !== "needs_dataset_work" &&
        executable,
    };
  });
}

function methodExecutionTargets(
  method: TrainingMethod,
  destinations: NonNullable<
    TrainingViewProps["training"]["payload"]
  >["destinations"]
) {
  return [
    executionTarget(
      method,
      "local_cpu_fixture",
      "Local CPU · Experimental",
      destinations
    ),
    executionTarget(
      method,
      "fireworks",
      method === "grpo" ? "Fireworks RFT" : "Fireworks",
      destinations
    ),
  ];
}

function executionTarget(
  method: TrainingMethod,
  destinationId: "local_cpu_fixture" | "fireworks",
  label: string,
  destinations: NonNullable<
    TrainingViewProps["training"]["payload"]
  >["destinations"]
) {
  const destination = destinations.find(
    (candidate) => candidate.destinationId === destinationId
  );
  const destinationName =
    destinationId === "local_cpu_fixture" ? "Local CPU" : "Fireworks";
  const supportsMethod = Boolean(destination?.methods.includes(method));
  return {
    id: destinationId,
    label,
    available: Boolean(destination?.available && supportsMethod),
    reason: !destination
      ? `${destinationName} capabilities have not loaded.`
      : !supportsMethod
      ? `${destinationName} does not execute ${method.toUpperCase()}.`
      : destination.unavailableReason ??
        `${destinationName} is not available in this environment.`,
  };
}

function methodTradeoff(method: TrainingMethod): string {
  if (method === "sft")
    return "Imitate approved responses with assistant-only loss.";
  if (method === "dpo")
    return "Increase the margin between chosen and rejected responses.";
  if (method === "grpo")
    return "Sample grouped responses and optimize executable rewards.";
  return "Optimize a policy with a separately tracked value model.";
}

function datasetGuidance(intent: DatasetEvidenceIntent | null): string {
  if (!intent) {
    return "Choose an existing Dataset, or select a goal before building a new one.";
  }
  if (intent === "demonstrations") {
    return "Build or choose prompts paired with approved responses. OpenPond will recommend SFT.";
  }
  if (intent === "preferences") {
    return "Build or choose prompts with chosen and rejected responses for DPO.";
  }
  if (intent === "verifiable_reward") {
    return "Build or choose prompts with an executable reward and environment for GRPO or PPO.";
  }
  if (intent === "rubric") {
    return "Build or choose rubric examples and calibrate evaluation before selecting optimization.";
  }
  return "Discover evidence first; OpenPond will recommend a concrete Dataset shape and method.";
}

function presetsFor(method: TrainingMethod | null): Array<{
  id: ModelRunPreset;
  label: string;
  description: string;
}> {
  if (method === "grpo" || method === "ppo") {
    return [
      {
        id: "small_experiment",
        label: "Quick test",
        description:
          "Bound prompts, rollouts, output tokens, steps, time, and spend.",
      },
      {
        id: "standard",
        label: "Recommended",
        description: "Use the Dataset-aware recommended online budgets.",
      },
      {
        id: "custom",
        label: "Custom",
        description: "Set each rollout and optimizer limit explicitly.",
      },
    ];
  }
  return [
    {
      id: "small",
      label: "Quick test",
      description:
        "A bounded LoRA experiment with independent frozen evaluation.",
    },
    {
      id: "standard",
      label: "Recommended",
      description:
        "Use Dataset-aware recommended examples and optimizer limits.",
    },
    {
      id: "custom",
      label: "Custom",
      description:
        "Set examples, steps, sequence length, rank, time, and spend.",
    },
  ];
}

function presetFor(
  method: TrainingMethod | null,
  presetId: ModelRunPreset | null
) {
  return presetsFor(method).find(
    (preset) => preset.id === (presetId ?? "standard")
  );
}
