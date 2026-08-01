import {
  type Dispatch,
  type SetStateAction,
} from "react";
import type {
  BaseModelCandidate,
  ModelRunDraft,
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
} from "./model-run-editor-helpers";

const RUN_CONTROL_ID = "model-build-run-control";

type LaunchState = {
  ready: boolean;
  reason: string | null;
  actionLabel: string;
};

type TrainingConfiguration = {
  baseModel: ModelRunDraft["baseModel"];
  method: "sft" | "dpo" | "grpo" | "ppo";
  destinationId: TrainingDestinationId;
  recipe: TrainingRecipe;
  approval: TrainingStartApproval;
};

export function ModelRunSetupContent({
  activeStep,
  onStepChange,
  draft,
  setDraft,
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
  draft: ModelRunDraft;
  setDraft: Dispatch<SetStateAction<ModelRunDraft>>;
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
            draft,
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
                {draft.datasetMode === "build"
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
                  draft.method === candidate.method
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
                  setDraft((current) => ({
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
            draft.method === "sft"
            || draft.method === "dpo"
            || draft.method === "grpo"
            || draft.method === "ppo"
          ) ? (
            <TrainingStartDialog
              key={`${selectedTaskset.id}:${selectedTaskset.revision}:${draft.method}:${draft.runPreset}`}
              baseModelCandidates={baseModelCandidates}
              connection={connection}
              taskset={selectedTaskset}
              modelId={draft.modelId}
              destinations={destinations}
              initialMethod={draft.method}
              preferredBaseModel={draft.baseModel}
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
              runPreset={draft.runPreset ?? "standard"}
              hideMethodTabs
              approvalPresentation="dialog"
              configurationContent={
                <details className="model-run-options">
                  <summary>
                    <span>Training configuration</span>
                    <strong>
                      {presetFor(draft.method, draft.runPreset)?.label
                        ?? "Recommended"}
                    </strong>
                  </summary>
                  <div className="model-build-field">
                    <span>Training budget</span>
                    <DropdownSelect
                      label="Training budget"
                      value={draft.runPreset ?? "standard"}
                      options={presetsFor(draft.method).map((preset) => ({
                        value: preset.id,
                        label: preset.label,
                      }))}
                      onChange={(value) =>
                        setDraft((current) => ({
                          ...current,
                          runPreset: value as ModelRunPreset,
                          recipe: null,
                          updatedAt: new Date().toISOString(),
                        }))}
                    />
                    <small>
                      {presetFor(draft.method, draft.runPreset)
                        ?.description
                        ?? "Use Taskset-aware recommended limits."}
                    </small>
                  </div>
                  {draft.destinationId === "openpond_managed" ? (
                    <div className="model-build-field">
                      <span>Rollout execution</span>
                      <DropdownSelect
                        label="Rollout execution"
                        value={draft.managedRolloutPlacement ?? "local"}
                        options={[
                          { value: "local", label: "This desktop" },
                          { value: "remote", label: "Hosted Sandboxes" },
                        ]}
                        onChange={(value) =>
                          setDraft((current) => ({
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
                  ) : null}
                </details>
              }
              onReadinessChange={onLaunchStateChange}
              onConfigurationChange={onConfigurationChange}
              onClose={() => undefined}
              onOpenProviderSettings={onOpenProviderSettings}
              onPrepare={(destinationId, recipe, approval) =>
                training.actions.prepareTraining({
                  modelId: draft.modelId,
                  tasksetId: selectedTaskset.id,
                  destinationId,
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
                approval: TrainingStartApproval,
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
  );
}
