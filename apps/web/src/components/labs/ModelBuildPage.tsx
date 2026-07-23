import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import type {
  ModelBuildDraft,
  ModelBuildRunPreset,
  Taskset,
  TrainingDestinationId,
  TrainingMethod,
  TrainingRecipe,
} from "@openpond/contracts";
import type { ClientConnection } from "../../api";
import type { TrainingViewProps } from "../training/TrainingView";
import {
  TrainingStartDialog,
  type TrainingStartApproval,
} from "../training/TrainingStartDialog";

const RUN_CONTROL_ID = "model-build-run-control";
const METHODS = ["sft", "dpo", "grpo", "ppo"] as const;

export function ModelBuildPage({
  connection,
  initialObjective,
  initialTasksetId,
  profileId,
  training,
  onCancel,
  onFinished,
  renderDatasetBuilder,
  onOpenProviderSettings,
}: {
  connection: ClientConnection | null;
  initialObjective: string | null;
  initialTasksetId?: string;
  profileId: string;
  training: TrainingViewProps["training"];
  onCancel: () => void;
  onFinished: (modelId: string, tasksetId: string) => Promise<void>;
  renderDatasetBuilder: (onCreated: (tasksetId: string) => void) => ReactNode;
  onOpenProviderSettings?: () => void;
}) {
  const state = training.payload;
  const restored = useMemo(
    () => state?.modelBuildDrafts.find((candidate) =>
      candidate.status === "draft" || candidate.status === "ready_to_run") ?? null,
    [state?.modelBuildDrafts],
  );
  const initialTaskset = state?.tasksets.find(
    (candidate) => candidate.id === initialTasksetId,
  ) ?? null;
  const initialDraftRef = useRef<ModelBuildDraft | null>(null);
  if (!initialDraftRef.current) {
    initialDraftRef.current = initialTaskset
      ? bindTaskset(restored ?? newDraft(profileId, initialObjective), initialTaskset)
      : restored ?? newDraft(profileId, initialObjective);
  }
  const [draft, setDraft] = useState(initialDraftRef.current);
  const [savedSnapshot, setSavedSnapshot] = useState(
    restored ? comparable(restored) : "",
  );
  const [launchState, setLaunchState] = useState<{
    ready: boolean;
    reason: string | null;
    actionLabel: string;
  }>({
    ready: false,
    reason: "Select a Dataset.",
    actionLabel: "Run",
  });
  const selectedTaskset = state?.tasksets.find(
    (taskset) => taskset.id === draft.tasksetRef?.id
      && taskset.revision === draft.tasksetRef.revision
      && taskset.contentHash === draft.tasksetRef.contentHash,
  ) ?? null;
  const dirty = comparable(draft) !== savedSnapshot;
  const busy = Boolean(training.busyAction);
  const pageReason = buildPageReason(draft, selectedTaskset, launchState);
  const canRun = !busy && pageReason === null;

  useEffect(() => {
    if (!dirty) return undefined;
    const warn = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      event.returnValue = "";
    };
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [dirty]);

  const updateConfiguration = useCallback((configuration: {
    baseModel: ModelBuildDraft["baseModel"];
    method: "sft" | "dpo" | "grpo" | "ppo";
    destinationId: TrainingDestinationId;
    recipe: TrainingRecipe;
  }) => {
    setDraft((current) => ({
      ...current,
      baseModel: configuration.baseModel,
      method: configuration.method,
      destinationId: configuration.destinationId,
      recipe: configuration.recipe,
      updatedAt: new Date().toISOString(),
    }));
  }, []);

  const updateLaunchState = useCallback(
    (next: typeof launchState) => setLaunchState(next),
    [],
  );

  async function save(): Promise<ModelBuildDraft | null> {
    const next: ModelBuildDraft = {
      ...draft,
      status: pageReason === null ? "ready_to_run" : "draft",
      updatedAt: new Date().toISOString(),
    };
    const saved = await training.actions.saveModelBuildDraft(next);
    if (!saved) return null;
    setDraft(saved);
    setSavedSnapshot(comparable(saved));
    return saved;
  }

  async function cancel() {
    if (dirty && !window.confirm("Discard unsaved changes to this Model build?")) {
      return;
    }
    if (restored || savedSnapshot) {
      await training.actions.deleteModelBuildDraft(draft.id);
    }
    onCancel();
  }

  async function launch() {
    if (!canRun || !selectedTaskset) return;
    await save();
    document.getElementById(RUN_CONTROL_ID)?.click();
  }

  function selectTaskset(taskset: Taskset) {
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

  const methodCards = methodAvailability(selectedTaskset, state?.destinations ?? []);

  return (
    <main className="model-build-page" aria-label="Build Model">
      <header className="model-build-header">
        <div>
          <span className="model-build-eyebrow">Model Builder</span>
          <input
            aria-label="Model name"
            className="model-build-name"
            value={draft.name}
            onChange={(event) => setDraft((current) => ({
              ...current,
              name: event.target.value,
              updatedAt: new Date().toISOString(),
            }))}
          />
          <p>{dirty ? "Unsaved changes" : savedSnapshot ? "Draft saved" : "Not saved yet"}</p>
        </div>
        <div className="model-build-actions">
          <button className="training-button secondary" type="button" disabled={busy} onClick={() => void cancel()}>
            Cancel
          </button>
          <button className="training-button secondary" type="button" disabled={busy || !dirty || !draft.name.trim()} onClick={() => void save()}>
            Save
          </button>
          <span className="model-build-run-control" title={pageReason ?? launchState.actionLabel}>
            <button className="training-button" type="button" disabled={!canRun} onClick={() => void launch()}>
              {launchState.actionLabel}
            </button>
          </span>
        </div>
      </header>

      {pageReason ? <div className="model-build-readiness" role="status">{pageReason}</div> : null}

      <section className="model-build-section">
        <div className="model-build-section-heading">
          <div><span>1</span><h2>Dataset</h2></div>
          {selectedTaskset ? <strong>{selectedTaskset.name} · revision {selectedTaskset.revision}</strong> : null}
        </div>
        <div className="model-build-choice-grid">
          <button
            className={draft.datasetMode === "existing" ? "model-build-choice selected" : "model-build-choice"}
            type="button"
            onClick={() => setDraft((current) => ({ ...current, datasetMode: "existing", updatedAt: new Date().toISOString() }))}
          >
            <strong>Use existing Dataset</strong>
            <span>Bind one exact immutable Dataset revision.</span>
          </button>
          <button
            className={draft.datasetMode === "build" ? "model-build-choice selected" : "model-build-choice"}
            type="button"
            onClick={() => setDraft((current) => ({ ...current, datasetMode: "build", tasksetRef: null, updatedAt: new Date().toISOString() }))}
          >
            <strong>Build new Dataset</strong>
            <span>Start with examples, comparisons, rewards, or a rubric.</span>
          </button>
        </div>
        {draft.datasetMode === "existing" ? (
          <label className="model-build-field">
            <span>Dataset revision</span>
            <select
              aria-label="Dataset revision"
              value={selectedTaskset?.id ?? ""}
              onChange={(event) => {
                const taskset = state?.tasksets.find((candidate) => candidate.id === event.target.value);
                if (taskset) selectTaskset(taskset);
              }}
            >
              <option value="">Select a Dataset</option>
              {state?.tasksets.map((taskset) => (
                <option key={`${taskset.id}:${taskset.revision}`} value={taskset.id}>
                  {taskset.name} · r{taskset.revision} · {taskset.readiness?.ready ? "ready" : "needs work"}
                </option>
              ))}
            </select>
          </label>
        ) : draft.datasetMode === "build" && !selectedTaskset ? (
          <div className="model-build-dataset-builder">
            {renderDatasetBuilder((tasksetId) => {
              const taskset = state?.tasksets.find((candidate) => candidate.id === tasksetId);
              if (taskset) selectTaskset(taskset);
              else void training.refresh().then((next) => {
                const created = next?.tasksets.find((candidate) => candidate.id === tasksetId);
                if (created) selectTaskset(created);
              });
            })}
          </div>
        ) : null}
      </section>

      <section className="model-build-section">
        <div className="model-build-section-heading"><div><span>2</span><h2>Training method</h2></div></div>
        <div className="model-build-method-grid">
          {methodCards.map((candidate) => (
            <button
              className={draft.method === candidate.method ? "model-build-method selected" : "model-build-method"}
              key={candidate.method}
              type="button"
              disabled={!selectedTaskset}
              onClick={() => setDraft((current) => ({
                ...current,
                method: candidate.method,
                recipe: null,
                updatedAt: new Date().toISOString(),
              }))}
            >
              <span><strong>{candidate.method.toUpperCase()}</strong><em>{candidate.state}</em></span>
              <small>{candidate.reason}</small>
            </button>
          ))}
        </div>
      </section>

      <section className="model-build-section">
        <div className="model-build-section-heading"><div><span>3</span><h2>Run size</h2></div></div>
        <div className="model-build-preset-grid">
          {presetsFor(draft.method).map((preset) => (
            <button
              className={draft.runPreset === preset.id ? "model-build-choice selected" : "model-build-choice"}
              key={preset.id}
              type="button"
              onClick={() => setDraft((current) => ({ ...current, runPreset: preset.id, recipe: null, updatedAt: new Date().toISOString() }))}
            >
              <strong>{preset.label}</strong><span>{preset.description}</span>
            </button>
          ))}
        </div>
      </section>

      <section className="model-build-section">
        <div className="model-build-section-heading"><div><span>4</span><h2>Base model, destination, checks, and quote</h2></div></div>
        {selectedTaskset && draft.runPreset && (draft.method === "sft" || draft.method === "dpo" || draft.method === "grpo" || draft.method === "ppo") ? (
          <TrainingStartDialog
            key={`${selectedTaskset.id}:${selectedTaskset.revision}:${draft.method}:${draft.runPreset}`}
            baseModelCandidates={state?.baseModelCandidates ?? []}
            connection={connection}
            taskset={selectedTaskset}
            modelId={draft.modelId}
            destinations={state?.destinations ?? []}
            initialMethod={draft.method}
            preferredBaseModel={draft.baseModel}
            busy={["baseline", "prepare-training", "start-prepared-training", "start-training"].includes(training.busyAction ?? "")}
            busyAction={training.busyAction}
            baselineReports={state?.baselineReports.filter((report) =>
              report.tasksetId === selectedTaskset.id
              && report.tasksetHash === selectedTaskset.contentHash) ?? []}
            baselineRuns={state?.baselineRuns.filter((run) => run.tasksetId === selectedTaskset.id) ?? []}
            presentation="embedded"
            hideActions
            runControlId={RUN_CONTROL_ID}
            runPreset={draft.runPreset}
            onReadinessChange={updateLaunchState}
            onConfigurationChange={updateConfiguration}
            onClose={() => undefined}
            onOpenProviderSettings={onOpenProviderSettings}
            onRunBaseline={async (model, options) => Boolean(
              await training.actions.baseline(selectedTaskset.id, model, options),
            )}
            onPrepare={(destinationId, recipe, approval) => training.actions.prepareTraining({
              modelId: draft.modelId,
              tasksetId: selectedTaskset.id,
              destinationId,
              recipe,
              exportApproved: approval.exportApproved,
              retentionDays: approval.retentionDays,
              region: approval.region,
            })}
            onConfirmPrepared={async (prepared, maximumCostUsd) => {
              const started = await training.actions.startPreparedTraining({
                planId: prepared.plan.id,
                bundleId: prepared.bundle.id,
                maximumCostUsd,
              });
              if (!started) return false;
              await training.actions.deleteModelBuildDraft(draft.id);
              await onFinished(draft.modelId, selectedTaskset.id);
              return true;
            }}
            onStart={async (destinationId, recipe, approval: TrainingStartApproval) => {
              const started = await training.actions.startTraining({
                modelId: draft.modelId,
                tasksetId: selectedTaskset.id,
                destinationId,
                recipe,
                ...approval,
              });
              if (!started) return false;
              await training.actions.deleteModelBuildDraft(draft.id);
              await onFinished(draft.modelId, selectedTaskset.id);
              return true;
            }}
          />
        ) : (
          <div className="model-build-empty">Complete the Dataset, method, and run-size sections to configure execution.</div>
        )}
      </section>
    </main>
  );
}

function newDraft(profileId: string, objective: string | null): ModelBuildDraft {
  const timestamp = new Date().toISOString();
  const suffix = crypto.randomUUID();
  return {
    schemaVersion: "openpond.modelBuildDraft.v1",
    id: `model_build_${suffix}`,
    profileId,
    modelId: `model_${suffix}`,
    name: "Untitled Model",
    objective,
    status: "draft",
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

function bindTaskset(draft: ModelBuildDraft, taskset: Taskset): ModelBuildDraft {
  return {
    ...draft,
    datasetMode: "existing",
    tasksetRef: {
      id: taskset.id,
      revision: taskset.revision,
      contentHash: taskset.contentHash,
    },
    updatedAt: new Date().toISOString(),
  };
}

function comparable(draft: ModelBuildDraft): string {
  const { updatedAt: _updatedAt, status: _status, ...value } = draft;
  return JSON.stringify(value);
}

function buildPageReason(
  draft: ModelBuildDraft,
  taskset: Taskset | null,
  launchState: { ready: boolean; reason: string | null },
): string | null {
  if (!draft.name.trim()) return "Name this Model.";
  if (!draft.datasetMode) return "Choose an existing Dataset or build a new one.";
  if (!taskset) return draft.datasetMode === "build" ? "Finish and save the Dataset." : "Select a Dataset.";
  if (!draft.method) return "Choose a training method.";
  const readiness = taskset.readiness?.methodReadiness.find((item) => item.method === draft.method);
  if (readiness?.status === "needs_dataset_work") {
    return readiness.reasons[0] ?? "Resolve Dataset readiness for this method.";
  }
  if (!draft.runPreset) return draft.method === "grpo" || draft.method === "ppo"
    ? "Choose an experiment size."
    : "Choose a run size.";
  if (!draft.baseModel) return "Choose a base model.";
  if (!draft.destinationId) return "Choose a compatible destination.";
  return launchState.ready ? null : launchState.reason ?? "Complete the launch checks.";
}

function methodAvailability(
  taskset: Taskset | null,
  destinations: NonNullable<TrainingViewProps["training"]["payload"]>["destinations"],
) {
  return METHODS.map((method) => {
    const readiness = taskset?.readiness?.methodReadiness.find((item) => item.method === method);
    const executable = destinations.some((destination) =>
      destination.available && destination.methods.includes(method));
    const state = readiness?.status === "needs_dataset_work"
      ? "Needs Dataset work"
      : !executable
        ? "Destination unavailable"
        : readiness?.status === "recommended"
          ? "Recommended"
          : "Compatible";
    const reason = readiness?.reasons[0]
      ?? (!executable
        ? `No configured destination currently executes ${method.toUpperCase()}.`
        : methodTradeoff(method));
    return { method, state, reason };
  });
}

function methodTradeoff(method: TrainingMethod): string {
  if (method === "sft") return "Imitate approved responses with assistant-only loss.";
  if (method === "dpo") return "Increase the margin between chosen and rejected responses.";
  if (method === "grpo") return "Sample grouped responses and optimize executable rewards.";
  return "Optimize a policy with a separately tracked value model.";
}

function presetsFor(method: TrainingMethod | null): Array<{
  id: ModelBuildRunPreset;
  label: string;
  description: string;
}> {
  if (method === "grpo" || method === "ppo") {
    return [
      { id: "small_experiment", label: "Small experiment", description: "Bound prompts, rollouts, output tokens, steps, time, and spend." },
      { id: "standard", label: "Standard", description: "Use the Dataset-aware recommended online budgets." },
      { id: "custom", label: "Custom", description: "Set each rollout and optimizer limit explicitly." },
    ];
  }
  return [
    { id: "small", label: "Small run", description: "A bounded LoRA experiment with independent frozen evaluation." },
    { id: "standard", label: "Standard", description: "Use Dataset-aware recommended examples and optimizer limits." },
    { id: "custom", label: "Custom", description: "Set examples, steps, sequence length, rank, time, and spend." },
  ];
}
