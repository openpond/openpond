import type {
  ModelProject,
  ModelRunDraft,
  ModelRunPreset,
  Taskset,
  TrainingMethod,
  TrainingPreparationPlan,
} from "@openpond/contracts";

import type { DatasetEvidenceIntent } from "../training/TrainingGoalCards";
import type { TrainingViewProps } from "../training/TrainingView";
import type { ModelSetupStepId } from "./ModelSetupSteps";

const METHODS = ["sft", "dpo", "grpo", "ppo"] as const;

export function newProject(
  profileId: string,
  objective: string | null,
  modelId?: string,
  name?: string,
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

export function firstIncompleteSetupStep(
  draft: ModelRunDraft,
): ModelSetupStepId {
  if (!draft.buildIntent) return "goal";
  if (!draft.tasksetRef) return "dataset";
  if (!draft.method) return "method";
  return "configuration";
}

export function setupStepComplete(
  step: ModelSetupStepId,
  draft: ModelRunDraft,
  taskset: Taskset | null,
  canRun: boolean,
): boolean {
  if (step === "goal") return Boolean(draft.buildIntent);
  if (step === "dataset") return Boolean(taskset);
  if (step === "method") return Boolean(draft.method);
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

export function newDraft(
  profileId: string,
  modelId: string,
): ModelRunDraft {
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

export function bindTaskset(
  draft: ModelRunDraft,
  taskset: Taskset,
): ModelRunDraft {
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

export function cloneRunDraft(template: ModelRunDraft): ModelRunDraft {
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
  draft: ModelRunDraft,
): string {
  const { updatedAt: _projectUpdatedAt, ...projectValue } = project;
  const { updatedAt: _draftUpdatedAt, status: _status, ...draftValue } = draft;
  return JSON.stringify({ project: projectValue, draft: draftValue });
}

export function buildPageReason(
  project: ModelProject,
  draft: ModelRunDraft,
  taskset: Taskset | null,
  launchState: { ready: boolean; reason: string | null },
): string | null {
  if (!project.name.trim()) return "Name this Model.";
  if (!draft.buildIntent) return "Choose what you want to build.";
  if (!draft.datasetMode) {
    return "Choose an existing Dataset or build a new one.";
  }
  if (!taskset) return "Choose or build a Dataset to enable Run.";
  if (!draft.method) return "Choose a training method.";
  const readiness = taskset.readiness?.methodReadiness.find(
    (item) => item.method === draft.method,
  );
  if (readiness?.status === "needs_dataset_work") {
    return readiness.reasons[0] ?? "Resolve Dataset readiness for this method.";
  }
  if (!draft.runPreset) {
    return draft.method === "grpo" || draft.method === "ppo"
      ? "Choose an experiment size."
      : "Choose a run size.";
  }
  if (!draft.baseModel) return "Choose a base model.";
  if (!draft.destinationId) return "Choose a compatible destination.";
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
    "No side effects have started. Confirming may begin downloads, connections, uploads, provisioning, or spend.",
  ].join(" ");
}

export function methodAvailability(
  taskset: Taskset | null,
  destinations: NonNullable<
    TrainingViewProps["training"]["payload"]
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
    TrainingViewProps["training"]["payload"]
  >["destinations"],
) {
  return [
    executionTarget(
      method,
      "local_cpu_fixture",
      "Local CPU · Experimental",
      destinations,
    ),
    executionTarget(
      method,
      "fireworks",
      method === "grpo" ? "Fireworks RFT" : "Fireworks",
      destinations,
    ),
  ];
}

function executionTarget(
  method: TrainingMethod,
  destinationId: "local_cpu_fixture" | "fireworks",
  label: string,
  destinations: NonNullable<
    TrainingViewProps["training"]["payload"]
  >["destinations"],
) {
  const destination = destinations.find(
    (candidate) => candidate.destinationId === destinationId,
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
