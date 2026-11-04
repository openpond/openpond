import type {
  ManagedAlphaEditExecutionPage,
  ManagedNeuronTrainingExecutionPage,
  ManagedDecisionExecutionPage,
  ManagedEngramExecutionPage,
  ExperimentDraftRecord,
  ModificationRecording,
  ManagedModificationExecutionSummary,
  TrainingExecutionSummary,
} from "openpond-sdk/training";
import type { LocalExperimentRecord } from "@openpond/contracts";
import type { ExperimentRunDetails, ExperimentGraderPin } from "openpond-sdk/experiments";
import type { WorkspaceApi } from "./workspace-api";

export type EvaluationExperimentCollectionRecord = {
  kind: "evaluation";
  name: string;
  dataset: ExperimentRunDetails["request"]["taskset"];
  key: string;
  id: string;
  location: "local" | "hosted";
  api: WorkspaceApi;
  request: ExperimentRunDetails["request"];
  graders: ExperimentGraderPin[];
  maximumCostUsd: number;
  packageHash?: string;
  status: string;
  createdAt: string;
  startedAt: string | null;
  completedAt: string | null;
  completed: number;
  total: number;
  modelId: string;
  manifestHash: string;
  resultAvailable: boolean;
  error: string | null;
  raw:
    | { location: "local"; value: LocalExperimentRecord }
    | { location: "hosted"; value: ExperimentRunDetails };
};
export function localExperimentRecord(
  api: WorkspaceApi,
  value: LocalExperimentRecord,
): EvaluationExperimentCollectionRecord {
  return {
    kind: "evaluation",
    name: value.configuration.request.name ?? value.id,
    dataset: value.configuration.request.taskset,
    key: `local:${value.id}`,
    id: value.id,
    location: "local",
    api,
    request: value.configuration.request,
    graders: value.graders,
    maximumCostUsd: value.maximumCostUsd,
    packageHash: value.packageHash,
    status: value.status === "completed" && value.counts.failed ? "failed" : value.status,
    createdAt: value.createdAt,
    startedAt: value.createdAt,
    completedAt: value.completedAt,
    completed: value.counts.completed,
    total: Object.values(value.counts).reduce((sum, count) => sum + count, 0),
    modelId: value.model.modelId,
    manifestHash: value.executionHash,
    resultAvailable: Boolean(value.completedAt && value.cleanupComplete),
    error: value.error,
    raw: { location: "local", value },
  };
}
export function hostedExperimentRecord(
  api: WorkspaceApi,
  value: ExperimentRunDetails,
): EvaluationExperimentCollectionRecord {
  return {
    kind: "evaluation",
    name: value.request.name ?? value.summary.id,
    dataset: value.request.taskset,
    key: `hosted:${value.summary.id}`,
    id: value.summary.id,
    location: "hosted",
    api,
    request: value.request,
    graders: value.configuration.graders,
    maximumCostUsd: value.configuration.maximumCostUsd,
    status:
      value.summary.status === "completed" && value.summary.counts.failed
        ? "failed"
        : value.summary.status,
    createdAt: value.summary.createdAt,
    startedAt: value.summary.startedAt,
    completedAt: value.summary.completedAt,
    completed: value.summary.counts.completed,
    total: value.summary.totalCount,
    modelId: "modelId" in value.request.policy ? value.request.policy.modelId : "Fixtures",
    manifestHash: value.summary.manifestHash,
    resultAvailable: value.summary.resultAvailable,
    error: value.summary.error?.message ?? null,
    raw: { location: "hosted", value },
  };
}

export type TrainingExperimentCollectionRecord = {
  kind: "training";
  key: string;
  id: string;
  location: "hosted";
  api: WorkspaceApi;
  name: string;
  dataset: TrainingExecutionSummary["dataset"];
  modelId: string;
  graders: [];
  status: string;
  createdAt: string;
  startedAt: string | null;
  completedAt: string | null;
  error: string | null;
  execution: TrainingExecutionSummary;
};
export type ExperimentCollectionRecord =
  | EvaluationExperimentCollectionRecord
  | ManagedModificationExperimentCollectionRecord
  | ModificationExperimentCollectionRecord
  | DraftExperimentCollectionRecord
  | TrainingExperimentCollectionRecord;
export type ManagedModificationExperimentCollectionRecord = {
  kind: "managed-modification";
  key: string;
  id: string;
  location: "hosted";
  api: WorkspaceApi;
  name: string;
  dataset: null;
  modelId: string;
  graders: [];
  status: string;
  createdAt: string;
  startedAt: null;
  completedAt: null;
  error: null;
  execution:
    | ManagedModificationExecutionSummary
    | ManagedEngramExecutionPage["items"][number]
    | ManagedDecisionExecutionPage["items"][number]
    | ManagedAlphaEditExecutionPage["items"][number]
    | ManagedNeuronTrainingExecutionPage["items"][number];
};
export function managedModificationExperimentRecord(
  api: WorkspaceApi,
  execution:
    | ManagedModificationExecutionSummary
    | ManagedEngramExecutionPage["items"][number]
    | ManagedDecisionExecutionPage["items"][number]
    | ManagedAlphaEditExecutionPage["items"][number]
    | ManagedNeuronTrainingExecutionPage["items"][number],
): ManagedModificationExperimentCollectionRecord {
  return {
    kind: "managed-modification",
    key: `${execution.method === "alphaedit" ? "managed-alphaedit" : execution.method === "selective_neuron_training" ? "managed-neuron-training" : execution.method === "decision_model" ? "managed-decision" : execution.method === "engram_adapter" ? "managed-engram" : "managed-modification"}:${execution.id}`,
    id: execution.id,
    location: "hosted",
    api,
    name: execution.name,
    dataset: null,
    modelId:
      execution.model.schemaVersion === "openpond.decisionModelIdentity.v1"
        ? execution.model.source.modelId
        : execution.model.modelId,
    graders: [],
    status: execution.phase,
    createdAt: execution.plan.createdAt,
    startedAt: null,
    completedAt: null,
    error: null,
    execution,
  };
}
export type ModificationExperimentCollectionRecord = {
  kind: "modification";
  key: string;
  id: string;
  location: "local";
  api: WorkspaceApi;
  name: string;
  dataset: null;
  modelId: string;
  graders: [];
  status: "recorded";
  createdAt: string;
  startedAt: null;
  completedAt: null;
  error: null;
  recording: ModificationRecording;
};
export function modificationExperimentRecord(
  api: WorkspaceApi,
  recording: ModificationRecording,
): ModificationExperimentCollectionRecord {
  return {
    kind: "modification",
    key: `modification:${recording.id}`,
    id: recording.id,
    location: "local",
    api,
    name: recording.name,
    dataset: null,
    modelId: recording.model.modelId,
    graders: [],
    status: "recorded",
    createdAt: recording.createdAt,
    startedAt: null,
    completedAt: null,
    error: null,
    recording,
  };
}
export type DraftExperimentCollectionRecord = {
  kind: "draft";
  key: string;
  id: string;
  location: "local" | "hosted";
  api: WorkspaceApi;
  name: string;
  dataset: TrainingExecutionSummary["dataset"];
  modelId: string;
  graders: [];
  status: string;
  createdAt: string;
  startedAt: null;
  completedAt: null;
  error: null;
  record: ExperimentDraftRecord;
};
export function draftExperimentRecord(
  api: WorkspaceApi,
  record: ExperimentDraftRecord,
): DraftExperimentCollectionRecord {
  const draft = record.draft;
  return {
    kind: "draft",
    key: `draft:${record.id}`,
    id: record.id,
    api,
    name: draft.name,
    location: draft.evaluationForm?.executionLocation ?? "hosted",
    graders: [],
    status: record.status,
    dataset:
      draft.evaluationForm?.form.release ??
      draft.trainingForm?.evaluation ??
      draft.training?.settings?.evaluationTasksetRef ??
      null,
    modelId:
      draft.evaluationForm?.form.modelId ??
      draft.alphaEditForm?.baseModel?.modelId ??
      draft.neuronTrainingForm?.baseModel?.modelId ??
      draft.decisionForm?.baseModel?.modelId ??
      draft.engramForm?.baseModel?.modelId ??
      draft.activationForm?.baseModel?.modelId ??
      draft.trainingForm?.baseModel?.modelId ??
      draft.training?.baseModel?.modelId ??
      "",
    createdAt: record.createdAt,
    startedAt: null,
    completedAt: null,
    error: null,
    record,
  };
}
export function trainingExperimentRecord(
  api: WorkspaceApi,
  execution: TrainingExecutionSummary,
): TrainingExperimentCollectionRecord {
  const job = execution.job;
  return {
    kind: "training",
    key: `training:hosted:${job.id}`,
    id: job.id,
    location: "hosted",
    api,
    name: execution.name,
    dataset: execution.dataset,
    modelId: execution.model?.modelId ?? "Unknown model",
    graders: [],
    status: job.state,
    createdAt: job.createdAt,
    startedAt: execution.startedAt,
    completedAt: job.completedAt,
    error: job.terminalReason,
    execution,
  };
}
