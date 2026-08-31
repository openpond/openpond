import {
  type Dispatch,
  type SetStateAction,
} from "react";
import type {
  BaseModelCandidate,
  LearnedPreferenceRewardBinding,
  ModelRunPreset,
  Taskset,
  TrainingDestinationCapabilities,
  TrainingDestinationId,
  TrainingRecipe,
} from "@openpond/contracts";
import type { ClientConnection } from "../../api";
import { DropdownSelect } from "../DropdownSelect";
import type { TrainingWorkspaceProps } from "../training/training-workspace-types";
import {
  TrainingStartDialog,
  type TrainingStartApproval,
} from "../training/TrainingStartDialog";
import {
  MODEL_SETUP_STEPS,
  ModelSetupSteps,
  type ModelSetupStepId,
} from "./ModelSetupSteps";
import {
  methodAvailability,
  presetFor,
  presetsFor,
  setupStepComplete,
  type ModelProjectEditorState,
} from "./model-run-editor-helpers";

const RUN_CONTROL_ID = "model-build-run-control";

type LaunchState = {
  ready: boolean;
  reason: string | null;
  actionLabel: string;
};

type TrainingConfiguration = {
  baseModel: ModelProjectEditorState["baseModel"];
  method: "sft" | "dpo" | "grpo" | "ppo";
  destinationId: TrainingDestinationId;
  recipe: TrainingRecipe;
  approval: TrainingStartApproval;
};

export function ModelRunSetupContent({
  activeStep,
  onStepChange,
  setup,
  learnedPreferenceReward,
  setSetup,
  selectedTaskset,
  methodCards,
  tasksets,
  baseModelCandidates,
  destinations,
  connection,
  training,
  canRun,
  onSelectTaskset,
  onOpenDatasetBuilder,
  onLaunchStateChange,
  onConfigurationChange,
  onOpenProviderSettings,
  onFinished,
}: {
  activeStep: ModelSetupStepId;
  onStepChange: (step: ModelSetupStepId) => void;
  setup: ModelProjectEditorState;
  learnedPreferenceReward: LearnedPreferenceRewardBinding | null;
  setSetup: Dispatch<SetStateAction<ModelProjectEditorState>>;
  selectedTaskset: Taskset | null;
  methodCards: ReturnType<typeof methodAvailability>;
  tasksets: Taskset[];
  baseModelCandidates: BaseModelCandidate[];
  destinations: TrainingDestinationCapabilities[];
  connection: ClientConnection | null;
  training: TrainingWorkspaceProps["training"];
  canRun: boolean;
  onSelectTaskset: (taskset: Taskset) => void;
  onOpenDatasetBuilder: () => void;
  onLaunchStateChange: (state: LaunchState) => void;
  onConfigurationChange: (configuration: TrainingConfiguration) => void;
  onOpenProviderSettings?: () => void;
  onFinished: (modelId: string, tasksetId: string) => Promise<void>;
}) {
  return (
    <>
      <ModelSetupSteps
        activeStep={activeStep}
        steps={MODEL_SETUP_STEPS.map((step) => ({
          ...step,
          complete: setupStepComplete(
            step.id,
            setup,
            selectedTaskset,
            canRun,
          ),
        }))}
        onStepChange={onStepChange}
      />

      {activeStep === "dataset" ? (
        <section className="model-build-section">
          <div className="model-build-section-heading">
            <div>
              <h2>Choose a Taskset</h2>
              <p>
                Use a ready Taskset, or create one conversationally in Chat.
              </p>
            </div>
          </div>
          <div className="model-build-dataset-step">
            <div className="model-build-existing-dataset">
              <div className="model-build-field">
                <span>Taskset revision</span>
                <DropdownSelect
                  label="Taskset revision"
                  value={selectedTaskset?.id ?? ""}
                  options={[
                    {
                      value: "",
                      label: tasksets.length
                        ? "Select a Taskset"
                        : "No Tasksets yet",
                      disabled: tasksets.length === 0,
                    },
                    ...tasksets.map((taskset) => ({
                      value: taskset.id,
                      label: `${taskset.name} · r${taskset.revision} · ${
                        taskset.readiness?.ready ? "ready" : "needs work"
                      }`,
                    })),
                  ]}
                  onChange={(value) => {
                    const taskset = tasksets.find(
                      (candidate) => candidate.id === value,
                    );
                    if (taskset) onSelectTaskset(taskset);
                  }}
                />
              </div>
              <button
                className="training-button secondary"
                type="button"
                onClick={onOpenDatasetBuilder}
              >
                {setup.datasetMode === "build"
                  ? "Continue building Taskset"
                  : "Build a Taskset"}
              </button>
            </div>
          </div>
        </section>
      ) : activeStep === "method" ? (
        <section className="model-build-section">
          <div className="model-build-section-heading">
            <h2>Choose a training method</h2>
          </div>
          <div className="model-build-method-grid">
            {methodCards.map((candidate) => (
              <button
                className={
                  setup.method === candidate.method
                    ? "model-build-method selected"
                    : "model-build-method"
                }
                key={candidate.method}
                type="button"
                disabled={!candidate.available}
                title={
                  candidate.available ? undefined : candidate.reason
                }
                onClick={() => {
                  setSetup((current) => ({
                    ...current,
                    method: candidate.method,
                    runPreset: "standard",
                    recipe: null,
                    updatedAt: new Date().toISOString(),
                  }));
                  onStepChange("configuration");
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
          {selectedTaskset
          && (
            setup.method === "sft"
            || setup.method === "dpo"
            || setup.method === "grpo"
            || setup.method === "ppo"
          ) ? (
            <TrainingStartDialog
              key={`${selectedTaskset.id}:${selectedTaskset.revision}:${setup.method}:${setup.runPreset}`}
              baseModelCandidates={baseModelCandidates}
              connection={connection}
              taskset={selectedTaskset}
              learnedPreferenceReward={learnedPreferenceReward}
              modelId={setup.projectId}
              destinations={destinations}
              initialMethod={setup.method}
              preferredBaseModel={setup.baseModel}
              busy={[
                "prepare-training",
                "prepare-model-run",
                "start-prepared-training",
                "start-training",
                "start-model-run",
              ].includes(training.busyAction ?? "")}
              busyAction={training.busyAction}
              presentation="embedded"
              hideActions
              runControlId={RUN_CONTROL_ID}
              runPreset={setup.runPreset ?? "standard"}
              hideMethodTabs
              approvalPresentation="dialog"
              configurationContent={
                <details className="model-run-options">
                  <summary>
                    <span>Training configuration</span>
                    <strong>
                      {presetFor(setup.method, setup.runPreset)?.label
                        ?? "Recommended"}
                    </strong>
                  </summary>
                  <div className="model-build-field">
                    <span>Training budget</span>
                    <DropdownSelect
                      label="Training budget"
                      value={setup.runPreset ?? "standard"}
                      options={presetsFor(setup.method).map((preset) => ({
                        value: preset.id,
                        label: preset.label,
                      }))}
                      onChange={(value) =>
                        setSetup((current) => ({
                          ...current,
                          runPreset: value as ModelRunPreset,
                          recipe: null,
                          updatedAt: new Date().toISOString(),
                        }))}
                    />
                    <small>
                      {presetFor(setup.method, setup.runPreset)
                        ?.description
                        ?? "Use Taskset-aware recommended limits."}
                    </small>
                  </div>
                  {setup.destinationId === "openpond_managed" ? (
                    <>
                      <div className="model-build-field">
                        <span>Rollout execution</span>
                        <DropdownSelect
                          label="Rollout execution"
                          value={setup.managedRolloutPlacement}
                          options={[
                            { value: "local", label: "This desktop" },
                            { value: "remote", label: "Hosted Sandboxes" },
                          ]}
                          onChange={(value) =>
                            setSetup((current) => ({
                              ...current,
                              managedRolloutPlacement:
                                value === "remote"
                                  ? "remote"
                                  : "local",
                              updatedAt: new Date().toISOString(),
                            }))}
                        />
                        <small>
                          This desktop keeps local integrations and provider
                          credentials on this device. Hosted Sandboxes can run
                          unattended.
                        </small>
                      </div>
                      <div className="model-build-field">
                        <span>GPU placement objective</span>
                        <DropdownSelect
                          label="GPU placement objective"
                          value={setup.managedGpuPlacementObjective}
                          options={[
                            { value: "balanced", label: "Balanced" },
                            { value: "fast", label: "Fastest supported" },
                            { value: "economical", label: "Most economical" },
                          ]}
                          onChange={(value) =>
                            setSetup((current) => ({
                              ...current,
                              managedGpuPlacementObjective:
                                value === "fast" || value === "economical"
                                  ? value
                                  : "balanced",
                              updatedAt: new Date().toISOString(),
                            }))}
                        />
                        <small>
                          Sandbox returns supported quotes and applies this
                          preference within the approved hard cost cap.
                        </small>
                      </div>
                    </>
                  ) : null}
                </details>
              }
              onReadinessChange={onLaunchStateChange}
              onConfigurationChange={onConfigurationChange}
              onClose={() => undefined}
              onOpenProviderSettings={onOpenProviderSettings}
              onPrepare={(destinationId, recipe, approval) =>
                training.actions.prepareTraining({
                  modelId: setup.projectId,
                  tasksetId: selectedTaskset.id,
                  destinationId,
                  environmentPlacement: setup.managedRolloutPlacement,
                  recipe,
                  exportApproved: approval.exportApproved,
                  retentionDays: approval.retentionDays,
                  region: approval.region,
                })}
              onConfirmPrepared={async (prepared, maximumCostUsd) => {
                const started =
                  await training.actions.startPreparedTraining({
                    planId: prepared.plan.id,
                    bundleId: prepared.bundle.id,
                    maximumCostUsd,
                  });
                if (!started) return false;
                await onFinished(setup.projectId, selectedTaskset.id);
                return true;
              }}
              onStart={async (
                destinationId,
                recipe,
                approval: TrainingStartApproval,
              ) => {
                const started = await training.actions.startTraining({
                  modelId: setup.projectId,
                  tasksetId: selectedTaskset.id,
                  destinationId,
                  environmentPlacement: setup.managedRolloutPlacement,
                  recipe,
                  ...approval,
                });
                if (!started) return false;
                await onFinished(setup.projectId, selectedTaskset.id);
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
  );
}
