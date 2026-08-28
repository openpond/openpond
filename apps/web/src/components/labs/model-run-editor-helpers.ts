import type {
  ModelProject,
  ModelProjectTrainingSetup,
  ModelRunPreset,
  Taskset,
  TrainingMethod,
  TrainingPreparationPlan,
} from "@openpond/contracts";

import type { DatasetEvidenceIntent } from "../training/TrainingGoalCards";
import type { TrainingWorkspaceProps } from "../training/training-workspace-types";
import type { ModelSetupStepId } from "./ModelSetupSteps";

const METHODS = ["sft", "dpo", "grpo", "ppo"] as const;

export type ModelProjectEditorState = ModelProjectTrainingSetup & {
  projectId: string;
  datasetMode: "existing" | "build" | null;
  updatedAt: string;
};

export function newProject(
  profileId: string,
  objective: string | null,
  modelId?: string,
  name?: string,
): ModelProject {
  const timestamp = new Date().toISOString();
  const suffix = crypto.randomUUID();
  return {
    schemaVersion: "openpond.modelProject.v2",
    id: modelId ?? `model_${suffix}`,
    profileId,
    revision: 1,
    name: name?.trim() || "Model #1",
    objective,
    defaultBaseModel: null,
    defaultDestinationId: null,
    trainingSetup: {
      tasksetRef: null,
      harnessRelease: null,
      tasksetRelease: null,
      baseModel: null,
      method: null,
      destinationId: null,
      managedRolloutPlacement: "remote",
      runPreset: null,
      recipe: null,
      preferredMaximumSpendUsd: null,
      preferredRetentionDays: null,
    },
    hosted: null,
    tasksetSyncs: [],
    createdAt: timestamp,
    updatedAt: timestamp,
  };
}

export function firstIncompleteSetupStep(
  setup: ModelProjectEditorState,
): ModelSetupStepId {
  if (!setup.tasksetRef) return "dataset";
  if (!setup.method) return "method";
  return "configuration";
}

export function setupStepComplete(
  step: ModelSetupStepId,
  setup: ModelProjectEditorState,
  taskset: Taskset | null,
  canRun: boolean,
): boolean {
  if (step === "dataset") return Boolean(taskset);
  if (step === "method") return Boolean(setup.method);
  return canRun;
}

export function nextModelName(
  projects: Array<Pick<ModelProject, "name">>,
): string {
  let highestNumber = projects.length;
  for (const project of projects) {
    const match = /^Model #(\d+)$/.exec(project.name.trim());
    if (match) highestNumber = Math.max(highestNumber, Number(match[1]));
  }
  return `Model #${highestNumber + 1}`;
}

export function projectEditorState(
  project: ModelProject,
): ModelProjectEditorState {
  const setup = project.trainingSetup;
  return {
    ...setup,
    projectId: project.id,
    datasetMode: setup.tasksetRef ? "existing" : null,
    updatedAt: project.updatedAt,
  };
}

export function bindTaskset(
  setup: ModelProjectEditorState,
  taskset: Taskset,
): ModelProjectEditorState {
  return {
    ...setup,
    datasetMode: "existing",
    tasksetRef: {
      id: taskset.id,
      revision: taskset.revision,
      contentHash: taskset.contentHash,
    },
    updatedAt: new Date().toISOString(),
  };
}

export function buildIntentForTaskset(
  taskset: Taskset,
): DatasetEvidenceIntent {
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

export function comparableEditor(
  project: ModelProject,
  setup: ModelProjectEditorState,
): string {
  const {
    updatedAt: _projectUpdatedAt,
    trainingSetup: _projectTrainingSetup,
    ...projectValue
  } = project;
  const {
    updatedAt: _setupUpdatedAt,
    datasetMode: _datasetMode,
    projectId: _projectId,
    ...setupValue
  } = setup;
  return JSON.stringify({ project: projectValue, trainingSetup: setupValue });
}

export function buildPageReason(
  project: ModelProject,
  setup: ModelProjectEditorState,
  taskset: Taskset | null,
  launchState: { ready: boolean; reason: string | null },
): string | null {
  if (!project.name.trim()) return "Name this Model.";
  if (!setup.datasetMode) {
    return "Choose a Taskset.";
  }
  if (!taskset) return "Choose a Taskset to enable Run.";
  if (!setup.method) return "Choose a training method.";
  const readiness = taskset.readiness?.methodReadiness.find(
    (item) => item.method === setup.method,
  );
  if (readiness?.status === "needs_dataset_work") {
    return readiness.reasons[0] ?? "Resolve Taskset readiness for this method.";
  }
  if (!setup.runPreset) {
    return setup.method === "grpo" || setup.method === "ppo"
      ? "Choose an experiment size."
      : "Choose a run size.";
  }
  if (!setup.baseModel) return "Choose a base model.";
  if (!setup.destinationId) return "Choose a compatible destination.";
  return launchState.ready
    ? null
    : launchState.reason ?? "Complete the launch checks.";
}

export function preparationReview(
  preparation: TrainingPreparationPlan,
): string {
  const downloads = preparation.downloads.length
    ? preparation.downloads
        .map(
          (download) =>
            `${download.label}: ${formatReviewBytes(download.diskImpactBytes)} (${download.state})`,
        )
        .join("; ")
    : "No downloads";
  const movement = preparation.dataMovement.length
    ? preparation.dataMovement
        .map(
          (item) =>
            `${item.label}: ${item.direction}${
              item.bytes == null ? "" : ` ${formatReviewBytes(item.bytes)}`
            }`,
        )
        .join("; ")
    : "No remote data movement";
  const spend =
    preparation.quoteUsd == null
      ? "No provider spend quoted"
      : `Quote $${preparation.quoteUsd.toFixed(2)}; maximum $${
          preparation.maximumSpendUsd?.toFixed(2) ?? "not set"
        }`;
  return [
    `${preparationStateLabel(preparation.state)}${
      preparation.reason ? ` — ${preparation.reason}` : ""
    }.`,
    `Downloads: ${downloads}.`,
    `Data: ${movement}.`,
    `${spend}. Retention: ${
      preparation.retentionDays == null
        ? "local policy"
        : `${preparation.retentionDays} days`
    }.`,
    "Confirming explicitly authorizes export of this bounded, immutable Taskset release for this run.",
    "No side effects have started. Confirming may begin downloads, connections, uploads, provisioning, or spend.",
  ].join(" ");
}

export function methodAvailability(
  taskset: Taskset | null,
  destinations: NonNullable<
    TrainingWorkspaceProps["training"]["payload"]
  >["destinations"],
) {
  return METHODS.map((method) => {
    const readiness = taskset?.readiness?.methodReadiness.find(
      (item) => item.method === method,
    );
    const datasetCompatible = Boolean(
      taskset &&
        (taskset.capabilities.compatibleMethods.includes(method) ||
          taskset.readiness?.trainingPath?.bootstrap?.method === method),
    );
    const executable = destinations.some(
      (destination) =>
        destination.available && destination.methods.includes(method),
    );
    const state =
      readiness?.status === "needs_dataset_work"
        ? "Needs Taskset work"
        : !datasetCompatible
          ? "Incompatible Taskset"
          : !executable
            ? "Destination unavailable"
            : readiness?.status === "recommended"
              ? "Recommended"
              : "Compatible";
    const reason =
      readiness?.reasons[0] ??
      (!datasetCompatible
        ? `This Taskset revision does not contain the evidence required for ${method.toUpperCase()}.`
        : !executable
          ? `No configured destination currently executes ${method.toUpperCase()}.`
          : methodTradeoff(method));
    return {
      method,
      state,
      reason,
      executionTargets: methodExecutionTargets(method, destinations),
      available:
        datasetCompatible &&
        readiness?.status !== "needs_dataset_work" &&
        executable,
    };
  });
}

function methodExecutionTargets(
  method: TrainingMethod,
  destinations: NonNullable<
    TrainingWorkspaceProps["training"]["payload"]
  >["destinations"],
) {
  return [
    executionTarget(
      method,
      "openpond_managed",
      "OpenPond Managed",
      destinations,
    ),
  ];
}

function executionTarget(
  method: TrainingMethod,
  destinationId: "openpond_managed",
  label: string,
  destinations: NonNullable<
    TrainingWorkspaceProps["training"]["payload"]
  >["destinations"],
) {
  const destination = destinations.find(
    (candidate) => candidate.destinationId === destinationId,
  );
  const destinationName = "OpenPond Managed";
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
  if (method === "sft") {
    return "Imitate approved responses with assistant-only loss.";
  }
  if (method === "dpo") {
    return "Increase the margin between chosen and rejected responses.";
  }
  if (method === "grpo") {
    return "Sample grouped responses and optimize executable rewards.";
  }
  return "Optimize a policy with a separately tracked value model.";
}

export function datasetGuidance(
  intent: DatasetEvidenceIntent | null,
): string {
  if (!intent) {
    return "Choose an existing Taskset, or select a goal before building a new one.";
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
  return "Discover evidence first; OpenPond will recommend a concrete Taskset shape and method.";
}

export function presetsFor(
  method: TrainingMethod | null,
): Array<{
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
        description: "Use the Taskset-aware recommended online budgets.",
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
        "Use Taskset-aware recommended examples and optimizer limits.",
    },
    {
      id: "custom",
      label: "Custom",
      description:
        "Set examples, steps, sequence length, rank, time, and spend.",
    },
  ];
}

export function presetFor(
  method: TrainingMethod | null,
  presetId: ModelRunPreset | null,
) {
  return presetsFor(method).find(
    (preset) => preset.id === (presetId ?? "standard"),
  );
}

function preparationStateLabel(state: string): string {
  return state
    .replaceAll("_", " ")
    .replace(/^\w/, (value) => value.toUpperCase());
}

function formatReviewBytes(value: number): string {
  if (value < 1_024) return `${value} B`;
  if (value < 1_024 ** 2) return `${(value / 1_024).toFixed(1)} KB`;
  if (value < 1_024 ** 3) {
    return `${(value / 1_024 ** 2).toFixed(1)} MB`;
  }
  return `${(value / 1_024 ** 3).toFixed(1)} GB`;
}
