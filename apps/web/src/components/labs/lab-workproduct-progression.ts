import type {
  CreateImproveRun,
  CrossSystemFrontierBaselineRun,
  Taskset,
  TrainingJob,
  TrainingStateResponse,
} from "@openpond/contracts";

import { jobsForTaskset, statusLabel } from "../training/training-model-data";
import { frontierBaselineStatusLabel } from "./LabModelBaseline";
import type { LabWorkproductSummary } from "./lab-workproducts";

const COMPLETED_CREATE_IMPROVE_STATES = new Set<CreateImproveRun["state"]>([
  "released",
  "rejected",
  "ready",
  "ready_local",
  "published_hosted",
  "blocked",
  "failed",
  "cancelled",
]);

const ACTIVE_TRAINING_STATES = new Set<TrainingJob["status"]>([
  "queued",
  "starting",
  "running",
  "cancelling",
  "reconciling",
]);

export type LabWorkproductNextActionKind =
  | "review_run"
  | "resume_run"
  | "open_conversation"
  | "open_data"
  | "open_evals"
  | "open_training"
  | "start_training"
  | "start_agent_change";

export type LabWorkproductProgression = {
  statusLabel: string;
  statusValue: string;
  action: {
    kind: LabWorkproductNextActionKind;
    label: string;
  } | null;
  runId: string | null;
  conversationId: string | null;
};

export function labWorkproductProgression(input: {
  workproduct: LabWorkproductSummary;
  runs: CreateImproveRun[];
  taskset: Taskset | null;
  training: TrainingStateResponse | null;
}): LabWorkproductProgression {
  const latestRun = input.runs[0] ?? null;
  const resumableBlockedRun = latestRun?.state === "blocked"
    && latestRun.candidates.some((candidate) =>
      Boolean(candidate.git?.worktreePath)
      && ["draft", "checking"].includes(candidate.status),
    )
    ? latestRun
    : null;
  const activeRun =
    input.runs.find((run) => !COMPLETED_CREATE_IMPROVE_STATES.has(run.state)) ??
    null;

  if (input.workproduct.kind === "model" && input.taskset) {
    const latestTrainingJob = jobsForTaskset(input.training, input.taskset.id)[0] ?? null;
    if (latestTrainingJob && ACTIVE_TRAINING_STATES.has(latestTrainingJob.status)) {
      return progressionForModel({
        taskset: input.taskset,
        training: input.training,
        latestRun,
        fallbackStatus: input.workproduct.status,
      });
    }
  }

  if (resumableBlockedRun) return progressionForRun(resumableBlockedRun);
  if (activeRun) return progressionForRun(activeRun);

  if (input.workproduct.kind === "model") {
    const frontierBaseline = input.workproduct.frontierBaselineRunId
      ? input.training?.frontierBaselineRuns.find(
          (run) => run.id === input.workproduct.frontierBaselineRunId,
        ) ?? null
      : null;
    if (frontierBaseline) return progressionForFrontierBaseline(frontierBaseline);
    if (!input.taskset && latestRun && ["failed", "blocked", "cancelled"].includes(latestRun.state)) {
      return progressionForRun(latestRun);
    }
    return progressionForModel({
      taskset: input.taskset,
      training: input.training,
      latestRun,
      fallbackStatus: input.workproduct.status,
    });
  }

  if (input.workproduct.kind === "agent") {
    return {
      statusLabel: input.workproduct.status,
      statusValue: input.workproduct.status,
      action: { kind: "start_agent_change", label: "Improve agent" },
      runId: latestRun?.id ?? null,
      conversationId: latestRun?.scope.conversationId ?? null,
    };
  }

  if (latestRun?.scope.conversationId) {
    return {
      statusLabel: input.workproduct.status,
      statusValue: input.workproduct.status,
      action: { kind: "open_conversation", label: "Open chat" },
      runId: latestRun.id,
      conversationId: latestRun.scope.conversationId,
    };
  }

  return {
    statusLabel: input.workproduct.status,
    statusValue: input.workproduct.status,
    action: null,
    runId: latestRun?.id ?? null,
    conversationId: latestRun?.scope.conversationId ?? null,
  };
}

function progressionForFrontierBaseline(
  run: CrossSystemFrontierBaselineRun,
): LabWorkproductProgression {
  return {
    statusLabel: frontierBaselineStatusLabel(run),
    statusValue: run.status,
    action: {
      kind: run.status === "succeeded" ? "open_data" : "open_evals",
      label: run.status === "succeeded" ? "Review data" : "View baseline",
    },
    runId: null,
    conversationId: null,
  };
}

function progressionForRun(run: CreateImproveRun): LabWorkproductProgression {
  const base = {
    statusLabel: createImproveStatusLabel(run),
    statusValue: run.state,
    runId: run.id,
    conversationId: run.scope.conversationId,
  };

  if (run.state === "awaiting_questions") {
    return { ...base, action: { kind: "review_run", label: "Review questions" } };
  }
  if (run.state === "awaiting_plan_approval") {
    return { ...base, action: { kind: "review_run", label: "Review plan" } };
  }
  if (run.state === "awaiting_promotion") {
    return { ...base, action: { kind: "review_run", label: run.target.kind === "agent" ? "Review update" : "Review candidate" } };
  }
  if (run.state === "pull_request_open") {
    return { ...base, action: { kind: "review_run", label: "Review change" } };
  }
  if (run.state === "paused") {
    return { ...base, action: { kind: "resume_run", label: "Resume" } };
  }
  if (run.state === "blocked") {
    const resumableCandidate = run.candidates.some((candidate) =>
      Boolean(candidate.git?.worktreePath)
      && ["draft", "checking"].includes(candidate.status),
    );
    return {
      ...base,
      action: resumableCandidate
        ? { kind: "resume_run", label: run.target.kind === "agent" ? "Continue update" : "Continue candidate" }
        : run.target.kind === "agent"
        ? { kind: "start_agent_change", label: "Try again" }
        : run.scope.conversationId
          ? { kind: "open_conversation", label: "Review blocker" }
          : null,
    };
  }
  if (run.state === "failed") {
    return {
      ...base,
      action: run.scope.conversationId
        ? { kind: "open_conversation", label: "Review failure" }
        : null,
    };
  }
  return {
    ...base,
    action: run.scope.conversationId
      ? { kind: "open_conversation", label: "View progress" }
      : null,
  };
}

function progressionForModel(input: {
  taskset: Taskset | null;
  training: TrainingStateResponse | null;
  latestRun: CreateImproveRun | null;
  fallbackStatus: string;
}): LabWorkproductProgression {
  const conversationId = input.latestRun?.scope.conversationId ?? null;
  if (!input.taskset) {
    return {
      statusLabel: "Creating data",
      statusValue: "planning",
      action: conversationId
        ? { kind: "open_conversation", label: "View progress" }
        : null,
      runId: input.latestRun?.id ?? null,
      conversationId,
    };
  }

  const jobs = jobsForTaskset(input.training, input.taskset.id);
  const latestJob = jobs[0] ?? null;
  const importedModel = latestJob
    ? input.training?.models.find(
        (model) => model.jobId === latestJob.id && model.status === "imported",
      ) ?? null
    : null;

  if (latestJob && ACTIVE_TRAINING_STATES.has(latestJob.status)) {
    return {
      statusLabel: statusLabel(latestJob.status),
      statusValue: latestJob.status,
      action: { kind: "open_training", label: "View run" },
      runId: input.latestRun?.id ?? null,
      conversationId,
    };
  }
  if (latestJob?.status === "failed") {
    return {
      statusLabel: "Training failed",
      statusValue: "failed",
      action: { kind: "open_training", label: "Review failure" },
      runId: input.latestRun?.id ?? null,
      conversationId,
    };
  }
  if (latestJob?.status === "succeeded") {
    const evaluationComplete =
      latestJob.metadata.frozenEvaluationComplete === true
      || Boolean(importedModel?.frozenEvaluationArtifactId);
    const evaluationPassed =
      typeof latestJob.metadata.frozenEvaluationThresholdPassed === "boolean"
        ? latestJob.metadata.frozenEvaluationThresholdPassed
        : importedModel?.promotable === true;
    if (evaluationComplete && !evaluationPassed) {
      return {
        statusLabel: "Evaluation failed",
        statusValue: "failed",
        action: { kind: "open_training", label: "Review results" },
        runId: input.latestRun?.id ?? null,
        conversationId,
      };
    }
    if (evaluationComplete && evaluationPassed) {
      return {
        statusLabel: importedModel?.promotable ? "Model ready" : "Evaluation passed",
        statusValue: importedModel?.promotable ? "ready" : "passed",
        action: { kind: "open_training", label: "Review results" },
        runId: input.latestRun?.id ?? null,
        conversationId,
      };
    }
    return {
      statusLabel: importedModel ? "Evaluation pending" : "Collecting model",
      statusValue: "running",
      action: { kind: "open_training", label: "Review results" },
      runId: input.latestRun?.id ?? null,
      conversationId,
    };
  }
  if (!input.taskset.readiness?.ready) {
    return {
      statusLabel: "Needs review",
      statusValue: "needs_review",
      action: { kind: "open_data", label: "Review data" },
      runId: input.latestRun?.id ?? null,
      conversationId,
    };
  }
  const baselineReward = input.taskset.readiness.baselineReward;
  if (
    input.taskset.readiness.recommendedMethod === "grpo"
    && !(
      input.taskset.readiness.baselineReportId
      && baselineReward
      && baselineReward.count >= 2
      && (baselineReward.variance ?? 0) > 0
      && (baselineReward.mean ?? 0) > 0.05
      && (baselineReward.mean ?? 0) < 0.95
    )
  ) {
    return {
      statusLabel: "Test base model",
      statusValue: "needs_review",
      action: { kind: "start_training", label: "Configure training" },
      runId: input.latestRun?.id ?? null,
      conversationId,
    };
  }
  return {
    statusLabel: "Ready to train",
    statusValue: "ready",
    action: { kind: "start_training", label: "Start training" },
    runId: input.latestRun?.id ?? null,
    conversationId,
  };
}

function createImproveStatusLabel(run: CreateImproveRun): string {
  const state = run.state;
  const isAgent = run.target.kind === "agent";
  const labels: Record<CreateImproveRun["state"], string> = {
    planning: "Planning",
    awaiting_questions: "Needs answers",
    awaiting_plan_approval: "Plan ready",
    paused: "Paused",
    applying_source: isAgent ? "Saving Agent" : "Applying changes",
    running_checks: isAgent ? "Running Evals" : "Running checks",
    evaluating: isAgent ? "Running Evals" : "Evaluating",
    awaiting_promotion: isAgent ? "Update ready" : "Candidate ready",
    opening_pull_request: "Opening review",
    pull_request_open: "Review open",
    reconciling_release: isAgent ? "Saving update" : "Merging change",
    released: "Released",
    rejected: "Rejected",
    ready: "Ready",
    ready_local: "Ready",
    pushing_hosted: "Syncing",
    running_hosted_checks: "Verifying hosted",
    published_hosted: "Published",
    blocked: "Blocked",
    failed: "Failed",
    cancelled: "Cancelled",
  };
  return labels[state];
}
