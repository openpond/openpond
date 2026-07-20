import { randomUUID } from "node:crypto";

import {
  CreateImprovePlanSchema,
  CreateImproveRunSchema,
  CreateImproveWorkflowCaptureSchema,
  conciseWorkproductName,
  nextCreateImproveRunRevision,
  type BaseModelPreference,
  type CreateImproveRun,
  type CreateImproveTarget,
  type Taskset,
  type TaskCreationSnapshot,
  type TrainingSourceRef,
} from "@openpond/contracts";

import type { SqliteStore } from "../store/store.js";
import {
  createEvidenceSnapshot,
  createTasksetRef,
} from "./create-improve-taskset-lineage.js";

export function createTasksetAuthoringCreateImproveRun(input: {
  profileId: string;
  objective: string | null;
  sourceIds: string[];
  sources?: TrainingSourceRef[];
  targetIntent?: TaskCreationSnapshot["request"]["targetIntent"];
  resourceIntent?: TaskCreationSnapshot["request"]["resourceIntent"];
  preferredBaseModelId?: string | null;
  preferredBaseModel?: BaseModelPreference | null;
  timestamp?: string;
}): CreateImproveRun {
  const timestamp = input.timestamp ?? new Date().toISOString();
  const id = `create_improve_${randomUUID()}`;
  const evidenceSnapshot = createEvidenceSnapshot({
    objective: input.objective?.trim() || (input.resourceIntent === "dataset"
      ? "Create a Dataset from selected sources."
      : "Create a model from selected evidence."),
    sources: input.sources ?? [],
    timestamp,
  });
  const targetIntent = input.targetIntent ?? {
    kind: "model" as const,
    id: null,
    displayName: null,
    operation: "create" as const,
  };
  const target = targetForIntent(targetIntent, input.objective);
  return CreateImproveRunSchema.parse({
    schemaVersion: "openpond.createImprove.run.v1",
    id,
    revision: 0,
    operation: targetIntent.operation,
    surface: "training",
    command: "training",
    objective: input.objective?.trim() || (input.resourceIntent === "dataset"
      ? "Create a Dataset from selected sources."
      : "Create a model from selected evidence."),
    state: "planning",
    adapter: {
      kind: "managed_artifact",
      sourceAuthority: "managed_artifact",
      activeProfile: input.profileId,
      confirmationPolicy: "always_require_plan_approval",
    },
    actor: { id: null, kind: "user", label: null },
    scope: {
      profileId: input.profileId,
      conversationId: null,
      originTurnId: null,
      workItemId: null,
      projectId: null,
      targetProject: null,
    },
    context: {
      messageIds: [],
      conversationExcerpts: [],
      attachments: [],
      apps: [],
      tools: [],
      signalRefs: input.sourceIds,
      evalRefs: [],
      targetRepoAssumptions: [],
    },
    target,
    evidenceSnapshots: [evidenceSnapshot],
    tasksetRef: null,
    targetSelection: {
      status: targetIntent.kind ? "confirmed" : "open",
      preselectedKind: targetIntent.kind,
      confirmedKind: targetIntent.kind,
    },
    plan: null,
    workflowCapture: null,
    executionPolicy: {
      mode: "background",
      pauseAllowed: true,
      cancellationAllowed: true,
    },
    iterationPolicy: {
      mode: "single",
      maximumAttempts: 1,
      currentAttempt: 0,
    },
    approvalIds: [],
    questionIds: [],
    questions: [],
    candidates: [],
    evaluationReceipts: [],
    checkRefs: [],
    sourceRefs: input.sourceIds,
    externalExecutionRefs: [],
    localProfileCommit: null,
    hostedSourceCommit: null,
    hostedSourceRef: null,
    releaseOutcome: {
      status: "not_requested",
      profileCommit: null,
      profileTag: null,
      releaseReceiptRef: null,
      updatedAt: null,
    },
    blockedReason: null,
    appliedActionIds: [],
    metadata: {
      specializedEvaluator: "taskset",
      source: "shared_taskset_authoring",
      resourceIntent: input.resourceIntent ?? "workproduct",
      preferredBaseModelId: input.preferredBaseModelId ?? null,
      preferredBaseModel: input.preferredBaseModel ?? null,
    },
    createdAt: timestamp,
    updatedAt: timestamp,
  });
}

export function createExistingTasksetModelCreateImproveRun(input: {
  profileId: string;
  taskset: Taskset;
  preferredBaseModelId: string;
  preferredBaseModel: BaseModelPreference;
  modelId?: string;
  timestamp?: string;
}): CreateImproveRun {
  const timestamp = input.timestamp ?? new Date().toISOString();
  const draft = createTasksetAuthoringCreateImproveRun({
    profileId: input.profileId,
    objective: input.taskset.objective,
    sourceIds: input.taskset.sourceRefs.map((source) => source.id),
    sources: input.taskset.sourceRefs,
    targetIntent: {
      kind: "model",
      id: input.modelId ?? `model_${randomUUID()}`,
      displayName: input.taskset.name,
      operation: "create",
    },
    resourceIntent: "workproduct",
    preferredBaseModelId: input.preferredBaseModelId,
    preferredBaseModel: input.preferredBaseModel,
    timestamp,
  });
  const tasksetRef = createTasksetRef({
    taskset: input.taskset,
    evidenceSnapshotIds: draft.evidenceSnapshots.map((snapshot) => snapshot.id),
    approvedAt: timestamp,
  });
  const reviewed = nextCreateImproveRunRevision(draft, {
    state: "awaiting_plan_approval",
    tasksetRef,
    targetSelection: {
      status: "confirmed",
      preselectedKind: "model",
      confirmedKind: "model",
    },
    sourceRefs: [
      ...new Set([
        ...draft.sourceRefs,
        input.taskset.id,
      ]),
    ],
    metadata: {
      ...draft.metadata,
      source: "existing_dataset_model",
      tasksetRevision: input.taskset.revision,
      tasksetHash: input.taskset.contentHash,
      preferredBaseModelId: input.preferredBaseModelId,
      preferredBaseModel: input.preferredBaseModel,
    },
    updatedAt: timestamp,
  });
  const evaluating = nextCreateImproveRunRevision(reviewed, {
    state: "evaluating",
    updatedAt: timestamp,
  });
  return nextCreateImproveRunRevision(evaluating, {
    state: "ready",
    updatedAt: timestamp,
  });
}

export function createModelTrainingCreateImproveRun(input: {
  profileId: string;
  modelId?: string | null;
  tasksetId: string;
  displayName: string;
  trainingPlanId: string;
  trainingJobId: string;
  objective?: string | null;
  tasksetRef: NonNullable<CreateImproveRun["tasksetRef"]>;
  evidenceSnapshots: CreateImproveRun["evidenceSnapshots"];
  timestamp?: string;
}): CreateImproveRun {
  const timestamp = input.timestamp ?? new Date().toISOString();
  const runId = `create_improve_${randomUUID()}`;
  const target = {
    kind: "model" as const,
    id: input.modelId ?? input.tasksetId,
    displayName: input.displayName,
    trainingPlanId: input.trainingPlanId,
    trainingJobId: input.trainingJobId,
    artifactId: null,
  };
  const planId = `model_training_plan_${input.trainingPlanId}`;
  return CreateImproveRunSchema.parse({
    schemaVersion: "openpond.createImprove.run.v1",
    id: runId,
    revision: 0,
    operation: "improve",
    surface: "training",
    command: "training",
    objective: input.objective?.trim() || `Train ${input.displayName}.`,
    state: "evaluating",
    adapter: {
      kind: "managed_artifact",
      sourceAuthority: "managed_artifact",
      activeProfile: input.profileId,
      confirmationPolicy: "approval_already_granted",
    },
    actor: { id: null, kind: "user", label: null },
    scope: {
      profileId: input.profileId,
      conversationId: null,
      originTurnId: null,
      workItemId: null,
      projectId: null,
      targetProject: null,
    },
    context: {
      messageIds: [],
      conversationExcerpts: [],
      attachments: [],
      apps: [],
      tools: [],
      signalRefs: [],
      evalRefs: [],
      targetRepoAssumptions: [],
    },
    target,
    evidenceSnapshots: input.evidenceSnapshots,
    tasksetRef: input.tasksetRef,
    targetSelection: {
      status: "confirmed",
      preselectedKind: "model",
      confirmedKind: "model",
    },
    plan: {
      schemaVersion: "openpond.createImprove.plan.v1",
      id: planId,
      runId,
      status: "approved",
      objective: input.objective?.trim() || `Train ${input.displayName}.`,
      summary: `Run the approved training plan for ${input.displayName}.`,
      capturedContextSummary: `Taskset ${input.tasksetId} is the reviewed training and Eval boundary.`,
      defaultChatAction: { key: null, label: input.displayName, required: false },
      sourcePlan: [],
      requirements: [],
      checks: [
        { name: "training-job", command: `training job ${input.trainingJobId}`, required: true },
        { name: "frozen-evaluation", command: "taskset evaluate frozen_eval", required: true },
      ],
      approvalId: null,
      approvedAt: timestamp,
      editedFromPlanId: null,
      metadata: {
        specializedEvaluator: "taskset",
        trainingPlanId: input.trainingPlanId,
      },
      createdAt: timestamp,
      updatedAt: timestamp,
    },
    workflowCapture: {
      schemaVersion: "openpond.createImprove.workflowCapture.v1",
      id: `model_training_workflow_${input.trainingJobId}`,
      runId,
      command: "training",
      objective: input.objective?.trim() || `Train ${input.displayName}.`,
      conversationExcerpts: [],
      attachments: [],
      apps: [],
      tools: [],
      sideEffects: [],
      profileActions: ["Train model", "Evaluate frozen Taskset"],
      externalProviders: [],
      environmentVariables: [],
      files: [`tasksets/${input.tasksetId}`],
      schedules: [],
      webhooks: [],
      channelTargets: [],
      outputArtifacts: [],
      targetRepoAssumptions: [],
      traceRefs: [],
      metadata: { trainingPlanId: input.trainingPlanId, trainingJobId: input.trainingJobId },
      createdAt: timestamp,
    },
    executionPolicy: { mode: "background", pauseAllowed: true, cancellationAllowed: true },
    iterationPolicy: { mode: "single", maximumAttempts: 1, currentAttempt: 1 },
    approvalIds: [],
    questionIds: [],
    questions: [],
    candidates: [{
      id: `model_candidate_${runId}`,
      target,
      status: "checking",
      git: null,
      parentCandidateId: null,
      tasksetRef: input.tasksetRef,
      authoringModelRef: null,
      allowedPaths: [],
      sourceRefs: [input.tasksetId],
      artifactRefs: [],
      checkRefs: [],
      evaluationReceiptRefs: [],
      createdAt: timestamp,
      updatedAt: timestamp,
      metadata: { trainingPlanId: input.trainingPlanId },
    }],
    evaluationReceipts: [],
    checkRefs: [],
    sourceRefs: [input.tasksetId],
    externalExecutionRefs: [{
      kind: "training_job",
      id: input.trainingJobId,
      status: "running",
      metadata: {
        tasksetId: input.tasksetId,
        trainingPlanId: input.trainingPlanId,
      },
    }],
    localProfileCommit: null,
    hostedSourceCommit: null,
    hostedSourceRef: null,
    releaseOutcome: {
      status: "not_requested",
      profileCommit: null,
      profileTag: null,
      releaseReceiptRef: null,
      updatedAt: null,
    },
    blockedReason: null,
    appliedActionIds: [],
    metadata: {
      source: "training_start",
      specializedEvaluator: "taskset",
    },
    createdAt: timestamp,
    updatedAt: timestamp,
  });
}

export function advanceUnexecutedModelRunTasksetRef(
  run: CreateImproveRun,
  taskset: Taskset,
): CreateImproveRun {
  if (
    run.target.kind !== "model"
    || !run.tasksetRef
    || run.tasksetRef.id !== taskset.id
  ) {
    throw new Error("Only a Model run for the same Taskset can advance its authoring revision.");
  }
  if (
    run.tasksetRef.revision === taskset.revision
    && run.tasksetRef.contentHash === taskset.contentHash
  ) {
    return run;
  }
  const executionStarted = Boolean(
    run.target.trainingPlanId
    || run.target.trainingJobId
    || run.target.artifactId
    || run.externalExecutionRefs.length
    || run.evaluationReceipts.length,
  );
  if (executionStarted) {
    throw new Error(
      `Model run ${run.id} already executed Taskset ${run.tasksetRef.id}@${run.tasksetRef.revision}; create a new run for revision ${taskset.revision}.`,
    );
  }
  const tasksetRef = createTasksetRef({
    taskset,
    evidenceSnapshotIds: run.evidenceSnapshots.map((snapshot) => snapshot.id),
    approvedAt: taskset.updatedAt,
  });
  return nextCreateImproveRunRevision(run, {
    tasksetRef,
    candidates: run.candidates.map((candidate) =>
      candidate.target.kind === "model"
        ? {
            ...candidate,
            tasksetRef,
            updatedAt: taskset.updatedAt,
            metadata: {
              ...candidate.metadata,
              tasksetRevision: taskset.revision,
              tasksetHash: taskset.contentHash,
            },
          }
        : candidate),
    metadata: {
      ...run.metadata,
      tasksetRevision: taskset.revision,
      tasksetHash: taskset.contentHash,
    },
    updatedAt: taskset.updatedAt,
  });
}

export async function syncTasksetAuthoringCreateImproveRun(
  store: SqliteStore,
  creation: TaskCreationSnapshot,
): Promise<CreateImproveRun | null> {
  const runId = creation.request.createImproveRunId;
  if (!runId) return null;
  let run = await store.getCreateImproveRun(runId);
  if (!run) return null;

  const taskset = creation.materializedTasksetId
    ? await store.getTaskset(creation.materializedTasksetId)
    : null;
  const tasksetRef = taskset && creation.proposal
    ? createTasksetRef({
        taskset,
        proposal: creation.proposal,
        evidenceSnapshotIds: run.evidenceSnapshots.map((snapshot) => snapshot.id),
        approvedAt: creation.updatedAt,
      })
    : run.tasksetRef;

  const target = resolvedTarget(run, creation);
  const desiredState = modelRunState(creation);
  const questions = creation.blockingQuestions.map((question) => ({
    id: question.id,
    kind: "free_text" as const,
    title: question.kind.replaceAll("_", " "),
    prompt: question.prompt,
    required: true,
    status: question.answer ? "answered" as const : "pending" as const,
    options: [],
    answer: question.answer
      ? {
          value: question.answer,
          label: null,
          detail: null,
          answeredAt: creation.updatedAt,
          metadata: {},
        }
      : null,
    metadata: { taskCreationQuestionKind: question.kind },
  }));
  const plan = creation.request.resourceIntent === "dataset"
    ? run.plan
    : modelPlan(run, creation);
  const workflowCapture = CreateImproveWorkflowCaptureSchema.parse({
    schemaVersion: "openpond.createImprove.workflowCapture.v1",
    id: `model_workflow_${creation.id}`,
    runId: run.id,
    command: "training",
    objective: run.objective,
    conversationExcerpts: [],
    attachments: [],
    apps: [],
    tools: [],
    sideEffects: [],
    profileActions: creation.request.resourceIntent === "dataset"
      ? ["Create Taskset", "Evaluate Taskset"]
      : ["Create Taskset", "Evaluate Taskset", "Train model"],
    externalProviders: [],
    environmentVariables: [],
    files: creation.materializedTasksetId ? [`tasksets/${creation.materializedTasksetId}`] : [],
    schedules: [],
    webhooks: [],
    channelTargets: [],
    outputArtifacts: creation.materializedTasksetId ? [creation.materializedTasksetId] : [],
    targetRepoAssumptions: [],
    traceRefs: [],
    metadata: { taskCreationId: creation.id },
    createdAt: run.createdAt,
  });
  const patch = {
    target,
    plan,
    workflowCapture,
    approvalIds: creation.materializationApprovalId ? [creation.materializationApprovalId] : [],
    questionIds: questions.map((question) => question.id),
    questions,
    tasksetRef,
    targetSelection: tasksetRef
      ? {
          status: "confirmed" as const,
          preselectedKind: run.targetSelection?.preselectedKind ?? null,
          confirmedKind: target.kind === "unselected" ? null : target.kind,
        }
      : run.targetSelection,
    sourceRefs: [
      ...new Set([
        ...run.sourceRefs,
        ...creation.request.sourceIds,
        ...(creation.materializedTasksetId ? [creation.materializedTasksetId] : []),
      ]),
    ],
    blockedReason: creation.blockedReason,
    metadata: {
      ...run.metadata,
      taskCreationId: creation.id,
      taskCreationState: creation.state,
      preferredBaseModelId: creation.request.preferredBaseModelId,
      preferredBaseModel: creation.request.preferredBaseModel,
    },
    updatedAt: creation.updatedAt,
  };

  for (const state of transitionPath(run.state, desiredState)) {
    run = nextCreateImproveRunRevision(run, {
      ...patch,
      state,
      candidates: run.candidates,
    });
    await store.upsertCreateImproveRun(run);
  }
  if (run.state === desiredState && run.updatedAt !== creation.updatedAt) {
    run = nextCreateImproveRunRevision(run, patch);
    await store.upsertCreateImproveRun(run);
  }
  return run;
}

function targetForIntent(
  intent: TaskCreationSnapshot["request"]["targetIntent"],
  objective: string | null,
): CreateImproveTarget {
  const requestedDisplayName = intent.displayName ?? objective?.trim() ?? null;
  const displayName = intent.kind === "model"
    ? conciseWorkproductName(requestedDisplayName, "New model")
    : requestedDisplayName;
  if (intent.kind === "agent") {
    return {
      kind: "agent",
      id: intent.id,
      displayName,
      defaultActionKey: intent.id ? `${intent.id}.chat` : null,
    };
  }
  if (intent.kind === "skill") {
    return { kind: "skill", id: intent.id, displayName, skillName: intent.id };
  }
  if (intent.kind === "extension") {
    return { kind: "extension", id: intent.id, displayName, slot: null };
  }
  if (intent.kind === "configuration") {
    return { kind: "configuration", id: intent.id, displayName, key: intent.id };
  }
  if (intent.kind === "model") {
    return {
      kind: "model",
      id: intent.id ?? `model_draft_${randomUUID()}`,
      displayName: displayName ?? "New model",
      trainingPlanId: null,
      trainingJobId: null,
      artifactId: null,
    };
  }
  return { kind: "unselected", id: null, displayName };
}

function resolvedTarget(
  run: CreateImproveRun,
  creation: TaskCreationSnapshot,
): CreateImproveTarget {
  if (creation.request.resourceIntent === "dataset") {
    return {
      kind: "unselected",
      id: null,
      displayName: creation.proposal?.name ?? run.target.displayName,
    };
  }
  const proposedDisplayName = creation.proposal?.name ?? run.target.displayName;
  const displayName = run.target.kind === "model" || creation.request.targetIntent.kind === "model"
    ? conciseWorkproductName(proposedDisplayName, "New model")
    : proposedDisplayName;
  if (run.target.kind !== "unselected") return { ...run.target, displayName };
  const recommendation = creation.proposal
    ? (creation.proposal.diagnosis.trainingEligible ? "model" : "agent")
    : null;
  return targetForIntent({
    kind: recommendation,
    id: null,
    displayName,
    operation: creation.request.targetIntent.operation,
  }, run.objective);
}

export async function failTasksetAuthoringCreateImproveRun(
  store: SqliteStore,
  run: CreateImproveRun,
  error: unknown,
): Promise<CreateImproveRun> {
  const failed = nextCreateImproveRunRevision(run, {
    state: "failed",
    blockedReason: error instanceof Error ? error.message : String(error),
    updatedAt: new Date().toISOString(),
  });
  return store.upsertCreateImproveRun(failed);
}

function modelPlan(
  run: CreateImproveRun,
  creation: TaskCreationSnapshot,
): CreateImproveRun["plan"] {
  if (!creation.proposal && !run.plan) return null;
  const timestamp = creation.updatedAt;
  const approvalId = creation.materializationApprovalId ?? run.plan?.approvalId ?? null;
  const approved = ["materializing", "validating", "ready"].includes(creation.state);
  return CreateImprovePlanSchema.parse({
    schemaVersion: "openpond.createImprove.plan.v1",
    id: run.plan?.id ?? `model_plan_${creation.id}`,
    runId: run.id,
    status: approved ? "approved" : "pending_approval",
    objective: run.objective,
    summary: creation.proposal
      ? `Create ${creation.proposal.name} from the reviewed evidence and Taskset design.`
      : run.plan?.summary ?? "Create a Taskset and model from the reviewed evidence.",
    capturedContextSummary: `${creation.request.sourceIds.length} evidence source${creation.request.sourceIds.length === 1 ? "" : "s"} selected.`,
    defaultChatAction: {
      key: null,
      label: creation.proposal?.name ?? run.target.displayName,
      required: false,
    },
    sourcePlan: creation.materializedTasksetId
      ? [{
          path: `tasksets/${creation.materializedTasksetId}`,
          operation: "create",
          reason: "Materialize the reviewed Taskset before training.",
        }]
      : [],
    requirements: [],
    checks: [
      { name: "taskset-readiness", command: "taskset readiness", required: true },
      { name: "frozen-evaluation", command: "taskset evaluate frozen_eval", required: true },
    ],
    approvalId,
    approvedAt: approved ? timestamp : null,
    editedFromPlanId: null,
    metadata: {
      specializedEvaluator: "taskset",
      taskCreationId: creation.id,
    },
    createdAt: run.plan?.createdAt ?? creation.createdAt,
    updatedAt: timestamp,
  });
}

function modelRunState(creation: TaskCreationSnapshot): CreateImproveRun["state"] {
  if (creation.state === "awaiting_questions" || creation.state === "awaiting_disclosure_approval") {
    return "awaiting_questions";
  }
  if (creation.state === "recommendation_ready" || creation.state === "awaiting_materialization_approval") {
    return "awaiting_plan_approval";
  }
  if (creation.state === "materializing") return "evaluating";
  if (creation.state === "validating") return "evaluating";
  if (creation.state === "ready") return "ready";
  if (creation.state === "blocked") return "blocked";
  if (creation.state === "failed") return "failed";
  if (creation.state === "cancelled") return "cancelled";
  return "planning";
}

function transitionPath(
  current: CreateImproveRun["state"],
  desired: CreateImproveRun["state"],
): CreateImproveRun["state"][] {
  if (current === desired) return [];
  if (desired === "ready") {
    if (current === "awaiting_plan_approval") return ["evaluating", "ready"];
    if (current === "applying_source") return ["running_checks", "evaluating", "ready"];
    if (current === "running_checks") return ["evaluating", "ready"];
  }
  if (desired === "evaluating" && current === "awaiting_plan_approval") return ["evaluating"];
  return [desired];
}
