import { randomUUID } from "node:crypto";

import {
  CreateImprovePlanSchema,
  CreateImproveRunSchema,
  CreateImproveWorkflowCaptureSchema,
  createImproveActionShapeFromMetadata,
  inferCreateImproveActionShape,
  nextCreateImproveRunRevision,
  type CreateImproveCommand,
  type CreateImproveRun,
  type CreateImproveSurface,
} from "@openpond/contracts";

import type { GoalApproval, GoalKind, GoalState } from "./types";

type LocalProfileInput = {
  activeProfile?: string | null;
  repoPath?: string | null;
  sourcePath?: string | null;
  localHead?: string | null;
};

type CreatePipelineInput = {
  goal: GoalState;
  command: CreateImproveCommand;
  surface: CreateImproveSurface;
  profile?: LocalProfileInput | null;
  actorId?: string | null;
};

export function shouldCreatePipelineForGoal(kind: GoalKind): boolean {
  return kind === "create_agent" || kind === "update_agent";
}

export function createInitialCreatePipeline(input: CreatePipelineInput): {
  snapshot: CreateImproveRun;
  approval: GoalApproval;
} {
  const now = new Date().toISOString();
  const runId = `create_improve_${randomUUID()}`;
  const planId = `create_plan_${randomUUID()}`;
  const approvalId = `approval_${randomUUID()}`;
  const operation = input.goal.kind === "update_agent" ? "improve" : "create";
  const createAgentId = input.goal.agentId ?? slugFromObjective(input.goal.objective);
  const sourceRoot = sourceRootPathForAgent(
    operation === "improve" && input.goal.agentId ? input.goal.agentId : createAgentId,
  );
  const target = {
    kind: "agent" as const,
    id: input.goal.agentId ?? createAgentId,
    displayName: null,
    defaultActionKey: input.goal.agentId ? `${input.goal.agentId}.chat` : `${createAgentId}.chat`,
  };
  const draft = CreateImproveRunSchema.parse({
    schemaVersion: "openpond.createImprove.run.v1",
    id: runId,
    revision: 0,
    operation,
    surface: input.surface,
    command: input.command,
    objective: input.goal.objective,
    adapter: {
      kind: "local",
      sourceAuthority: "local_profile",
      activeProfile: input.profile?.activeProfile ?? null,
      repoPath: input.profile?.repoPath ?? null,
      sourcePath: input.profile?.sourcePath ?? null,
      localHead: input.profile?.localHead ?? null,
      confirmationPolicy: "always_require_plan_approval",
    },
    actor: {
      id: input.actorId ?? null,
      kind: "user",
      label: null,
    },
    scope: {
      profileId: input.profile?.activeProfile ?? "default",
      conversationId: input.goal.conversationId,
      originTurnId: null,
      workItemId: input.goal.workItemId,
      projectId: input.goal.projectId,
      targetProject: input.goal.projectId
        ? {
            id: input.goal.projectId,
            name: null,
            workspacePath: null,
            sourceRef: null,
            baseSha: null,
          }
        : null,
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
    state: "planning",
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
    sourceRefs: [],
    externalExecutionRefs: [],
    localProfileCommit: input.profile?.localHead ?? null,
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
      goalKind: input.goal.kind,
      promptPack: input.goal.promptPack,
      sourceOwnership:
        "Profile source is durable agent code/config; local Goal state is operational run history and is not committed by default.",
      stateOwnership:
        "Local questions, answers, approvals, events, create plans, and workflow capture are stored under the configured local Goal storage root.",
    },
    createdAt: now,
    updatedAt: now,
  });
  const actionShape = inferCreateImproveActionShape(draft);
  const actionShapeDecisionSource = createImproveActionShapeFromMetadata(
    draft.metadata,
  )
    ? "request_metadata"
    : "default_chat_fallback";
  const plan = CreateImprovePlanSchema.parse({
    schemaVersion: "openpond.createImprove.plan.v1",
    id: planId,
    runId,
    status: "pending_approval",
    objective: input.goal.objective,
    summary:
      operation === "improve"
        ? "Edit the selected source-backed OpenPond profile agent after this plan is approved."
        : "Create a source-backed OpenPond profile agent after this plan is approved.",
    capturedContextSummary:
      input.surface === "local_extend"
        ? "Local extend request from the active profile source. No prior chat context was attached."
        : "Direct prompt request. No prior chat context was attached.",
    defaultChatAction: {
      key: input.goal.agentId ? `${input.goal.agentId}.chat` : "chat",
      label: "Default chat",
      required: true,
    },
    sourcePlan: [
      {
        path: sourceRoot,
        operation: operation === "improve" ? "update" : "create",
        reason:
          operation === "improve"
            ? "Revise the selected profile agent source while preserving the default chat route."
            : "Implement the new profile agent source without overwriting existing profile agents.",
      },
      {
        path: "settings/profile.yaml",
        operation: "update",
        reason: "Register the agent and expose the default chat action in the local profile catalog.",
      },
      {
        path: sdkOutputPath(sourceRoot, "agent-manifest.json"),
        operation: "inspect",
        reason:
          "Regenerate and reload the action catalog from SDK outputs after checks pass.",
      },
      {
        path: sdkOutputPath(sourceRoot, "action-registry.json"),
        operation: "inspect",
        reason:
          "Verify the default chat action and explicit actions are catalog-addressable.",
      },
    ],
    requirements: [
      {
        kind: "target_project",
        name: "active OpenPond profile source",
        status: "required",
        detail: input.profile?.sourcePath ?? "Resolved from the local goal workspace.",
        metadata: {},
      },
    ],
    checks: [
      { name: "inspect", command: "pnpm agent:inspect --json", required: true },
      { name: "build", command: "pnpm agent:build", required: true },
      { name: "validate", command: "pnpm agent:validate --json", required: true },
      { name: "eval", command: "pnpm agent:eval --json", required: true },
    ],
    approvalId,
    approvedAt: null,
    editedFromPlanId: null,
    metadata: {
      actionShape,
      actionShapeDecisionSource,
      reviewSections: [
        "What happened",
        "Agent/workflow plan",
        "Files/source to create",
        "Dependencies and runtime setup",
        "Secrets and connections needed",
        "Validation checks",
      ],
    },
    createdAt: now,
    updatedAt: now,
  });
  const workflowCapture = CreateImproveWorkflowCaptureSchema.parse({
    schemaVersion: "openpond.createImprove.workflowCapture.v1",
    id: `workflow_capture_${randomUUID()}`,
    runId,
    command: input.command,
    objective: input.goal.objective,
    conversationExcerpts: [],
    attachments: [],
    apps: [],
    tools: [],
    profileActions: [],
    externalProviders: [],
    environmentVariables: [],
    files: [],
    schedules: [],
    webhooks: [],
    channelTargets: [],
    outputArtifacts: [],
    targetRepoAssumptions: [],
    traceRefs: [],
    metadata: {
      capturePolicy:
        "Moderate capture only: names, high-level inputs/outputs, setup requirements, artifacts, and side effects. Raw secrets and large logs are excluded.",
    },
    createdAt: now,
  });
  const snapshot = CreateImproveRunSchema.parse({
    ...draft,
    state: "awaiting_plan_approval",
    plan,
    workflowCapture,
    approvalIds: [approvalId],
    revision: 1,
    updatedAt: now,
  });
  const approval: GoalApproval = {
    id: approvalId,
    goalId: input.goal.id,
    kind: "create_plan",
    title: operation === "improve" ? "Approve agent improvement plan" : "Approve agent create plan",
    reason:
      "OpenPond requires plan approval before mutating durable profile agent source.",
    payload: {
      planId,
      runId: snapshot.id,
      objective: input.goal.objective,
      defaultActionKey: plan.defaultChatAction.key,
      sourcePlan: plan.sourcePlan,
      checks: plan.checks,
    },
    createdAt: now,
    status: "pending",
    decidedAt: null,
    decisionNote: null,
  };
  return { snapshot, approval };
}

function slugFromObjective(objective: string): string {
  return normalizeAgentId(
    objective
      .toLowerCase()
      .replace(/['"]/g, "")
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 48) || "created-agent",
  );
}

function sourceRootPathForAgent(agentId: string): string {
  return agentId === "default" ? "agent" : `agents/${agentId}`;
}

function sdkOutputPath(sourceRoot: string, fileName: string): string {
  return sourceRoot === "agent"
    ? `.openpond/${fileName}`
    : `${sourceRoot}/.openpond/${fileName}`;
}

function normalizeAgentId(value: string): string {
  const normalized = value
    .trim()
    .toLowerCase()
    .replace(/['"]/g, "")
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 64);
  return normalized || "created-agent";
}

export function approveCreateImprovePlan(
  goal: GoalState,
  approvalId: string,
): GoalState {
  return decideCreateImprovePlan(goal, approvalId, "approved");
}

export function rejectCreateImprovePlan(
  goal: GoalState,
  approvalId: string,
  decisionNote?: string | null,
): GoalState {
  return decideCreateImprovePlan(goal, approvalId, "rejected", decisionNote);
}

export function cancelCreateImprovePlan(
  goal: GoalState,
  approvalId: string,
  decisionNote?: string | null,
): GoalState {
  return decideCreateImprovePlan(goal, approvalId, "cancelled", decisionNote);
}

export function reviseCreateImprovePlan(
  goal: GoalState,
  input: { revision: string },
): GoalState {
  const pipeline = goal.createImproveRun;
  if (!pipeline?.plan) {
    throw new Error("goal has no create plan to edit");
  }
  if (pipeline.plan.status !== "pending_approval") {
    throw new Error("only a pending create plan can be edited before source mutation");
  }
  const revision = input.revision.trim();
  if (!revision) {
    throw new Error("plan edit instructions are required");
  }
  const now = new Date().toISOString();
  const previousPlan = pipeline.plan;
  const nextPlan = CreateImprovePlanSchema.parse({
    ...previousPlan,
    id: `create_plan_${randomUUID()}`,
    status: "pending_approval",
    summary: `${previousPlan.summary}\n\nRevision requested: ${revision}`,
    sourcePlan: previousPlan.sourcePlan.map((item) => ({
      ...item,
      reason: `${item.reason} Revision requested: ${revision}`,
    })),
    approvedAt: null,
    editedFromPlanId: previousPlan.id,
    metadata: {
      ...previousPlan.metadata,
      revision,
      supersedesPlanId: previousPlan.id,
    },
    createdAt: now,
    updatedAt: now,
  });
  const approvals = goal.approvals.map((approval) =>
    approval.id === previousPlan.approvalId
      ? {
          ...approval,
          title: "Approve revised agent plan",
          reason:
            "OpenPond requires approval of the revised plan before mutating durable profile agent source.",
          payload: {
            ...approval.payload,
            planId: nextPlan.id,
            previousPlanId: previousPlan.id,
            objective: nextPlan.objective,
            defaultActionKey: nextPlan.defaultChatAction.key,
            sourcePlan: nextPlan.sourcePlan,
            checks: nextPlan.checks,
            revision,
          },
          status: "pending" as const,
          decidedAt: null,
          decisionNote: null,
        }
      : approval
  );
  return {
    ...goal,
    status: "awaiting_approval",
    approvals,
    createImproveRun: nextCreateImproveRunRevision(pipeline, {
      state: "awaiting_plan_approval",
      plan: nextPlan,
      blockedReason: null,
      metadata: {
        ...pipeline.metadata,
        previousPlanId: previousPlan.id,
      },
      updatedAt: now,
    }),
    updatedAt: now,
  };
}

function decideCreateImprovePlan(
  goal: GoalState,
  approvalId: string,
  decision: "approved" | "rejected" | "cancelled",
  decisionNote?: string | null,
): GoalState {
  const pipeline = goal.createImproveRun;
  if (!pipeline?.plan || pipeline.plan.approvalId !== approvalId) return goal;
  const now = new Date().toISOString();
  const nextState =
    decision === "approved"
      ? "applying_source"
      : decision === "cancelled"
        ? "cancelled"
        : "blocked";
  return {
    ...goal,
    createImproveRun: nextCreateImproveRunRevision(pipeline, {
      state: nextState,
      plan: {
        ...pipeline.plan,
        status: decision,
        approvedAt: decision === "approved" ? now : pipeline.plan.approvedAt,
        metadata: {
          ...pipeline.plan.metadata,
          decision,
          ...(decisionNote ? { decisionNote } : {}),
        },
        updatedAt: now,
      },
      blockedReason:
        decision === "rejected"
          ? "Create plan rejected before source mutation."
          : decision === "cancelled"
            ? "Create plan cancelled before source mutation."
            : null,
      updatedAt: now,
    }),
  };
}
