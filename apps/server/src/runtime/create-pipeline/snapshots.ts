import {
  CreateImproveRunSchema,
  nextCreateImproveRunRevision,
  type Approval,
  type CreateImproveRun,
  type CreateImproveRunAction,
  type OpenPondApp,
  type RuntimeEvent,
  type SendTurnRequest,
  type Session,
  type Turn,
  type WorkspaceToolRequest,
} from "@openpond/contracts";
import { now } from "../../utils.js";
import { resolveWorkspaceExecutionTarget } from "../../workspace/workspace-execution-target.js";

export function shouldRunCreateImprovePlanner(run: CreateImproveRun): boolean {
  return run.state === "planning" && !run.plan;
}

export function threadGoalFromTurnMetadata(metadata: SendTurnRequest["metadata"]): {
  output: string;
  data: Record<string, unknown>;
} | null {
  const value = metadata?.threadGoal;
  if (!value || typeof value !== "object") return null;
  const record = value as Record<string, unknown>;
  const objective = typeof record.objective === "string" && record.objective.trim()
    ? record.objective.trim()
    : "Goal runtime updated";
  const provider = typeof record.provider === "string" && record.provider.trim()
    ? record.provider.trim()
    : "openpond";
  return {
    output: objective,
    data: { kind: "thread_goal", provider, goal: record },
  };
}

type CreateImprovePlanStatus = NonNullable<CreateImproveRun["plan"]>["status"];

export function approvalStatusForPlan(status: CreateImprovePlanStatus): Approval["status"] {
  if (status === "approved") return "accepted";
  if (status === "rejected") return "declined";
  if (status === "cancelled") return "cancelled";
  return "pending";
}

export function createImprovePlanApproval(input: {
  existing?: Approval | null;
  session: Session;
  turn: Turn;
  run: CreateImproveRun;
  status: Approval["status"];
}): Approval {
  const plan = input.run.plan;
  return {
    id: plan?.approvalId ?? `approval_${input.run.id}`,
    sessionId: input.session.id,
    turnId: input.turn.id,
    providerRequestId: input.run.id,
    kind: "create_plan",
    title: `${input.run.operation === "improve" ? "Approve improvement plan" : "Approve creation plan"}: ${input.run.objective}`,
    detail: JSON.stringify(
      {
        runId: input.run.id,
        revision: input.run.revision,
        planId: plan?.id ?? null,
        target: input.run.target,
        objective: input.run.objective,
        summary: plan?.summary ?? null,
        sourcePlan: plan?.sourcePlan ?? [],
        requirements: plan?.requirements ?? [],
        checks: plan?.checks ?? [],
        workflowCaptureId: input.run.workflowCapture?.id ?? null,
      },
      null,
      2,
    ),
    status: input.status,
    createdAt: input.existing?.createdAt ?? input.run.createdAt,
  };
}

export function applyCreateImproveRunAction(
  run: CreateImproveRun,
  action: CreateImproveRunAction,
): CreateImproveRun {
  if (run.id !== action.runId) throw new Error("Create/Improve action targets another run.");
  if (run.appliedActionIds.includes(action.actionId)) return run;
  const timestamp = now();
  if (action.type === "approve_plan") {
    if (run.state !== "awaiting_plan_approval" || !run.plan) {
      throw new Error("Create/Improve plan is not ready for approval.");
    }
    return nextCreateImproveRunRevision(run, {
      state: run.target.kind === "model" ? "evaluating" : "applying_source",
      plan: {
        ...run.plan,
        status: "approved",
        approvedAt: run.plan.approvedAt ?? timestamp,
        updatedAt: timestamp,
      },
      blockedReason: null,
      updatedAt: timestamp,
    }, action.actionId);
  }
  if (action.type === "cancel") {
    if (!run.executionPolicy.cancellationAllowed) {
      throw new Error("This Create/Improve run cannot be cancelled.");
    }
    const reason = action.reason?.trim() || "Cancelled before completion.";
    return nextCreateImproveRunRevision(run, {
      state: "cancelled",
      plan: run.plan
        ? {
            ...run.plan,
            status: "cancelled",
            approvedAt: null,
            metadata: { ...run.plan.metadata, cancellationReason: reason },
            updatedAt: timestamp,
          }
        : null,
      blockedReason: reason,
      metadata: { ...run.metadata, cancellationReason: reason },
      updatedAt: timestamp,
    }, action.actionId);
  }
  if (action.type === "revise_plan") {
    if (run.state !== "awaiting_plan_approval" || !run.plan) {
      throw new Error("Create/Improve plan is not ready for revision.");
    }
    const previousPlan = run.plan;
    return nextCreateImproveRunRevision(run, {
      state: "awaiting_plan_approval",
      plan: {
        ...previousPlan,
        id: `create_improve_plan_${crypto.randomUUID()}`,
        status: "pending_approval",
        summary: `${previousPlan.summary}\n\nRevision requested: ${action.revision}`,
        sourcePlan: previousPlan.sourcePlan.map((item) => ({
          ...item,
          reason: `${item.reason} Revision requested: ${action.revision}`,
        })),
        approvedAt: null,
        editedFromPlanId: previousPlan.id,
        metadata: {
          ...previousPlan.metadata,
          revision: action.revision,
          supersedesPlanId: previousPlan.id,
        },
        createdAt: timestamp,
        updatedAt: timestamp,
      },
      metadata: { ...run.metadata, previousPlanId: previousPlan.id },
      updatedAt: timestamp,
    }, action.actionId);
  }
  if (action.type === "answer_question") {
    if (run.state !== "awaiting_questions") {
      throw new Error("Create/Improve run is not waiting for questions.");
    }
    const question = run.questions.find((candidate) => candidate.id === action.questionId);
    if (!question || question.status !== "pending") {
      throw new Error("Create/Improve question is no longer pending.");
    }
    const option = question.options.find((candidate) => candidate.value === action.value);
    const questions = run.questions.map((candidate) =>
      candidate.id === action.questionId
        ? {
            ...candidate,
            status: "answered" as const,
            answer: {
              value: action.value,
              label: option?.label ?? null,
              detail: null,
              answeredAt: timestamp,
              metadata: {},
            },
          }
        : candidate,
    );
    const remainingRequired = questions.some(
      (candidate) => candidate.required && candidate.status === "pending",
    );
    return nextCreateImproveRunRevision(run, {
      state: remainingRequired ? "awaiting_questions" : "planning",
      questions,
      plan: null,
      blockedReason: null,
      updatedAt: timestamp,
    }, action.actionId);
  }
  if (action.type === "open_pull_request" || action.type === "apply_candidate") {
    const retryingLocalVerification =
      action.type === "apply_candidate" &&
      run.state === "blocked" &&
      Boolean(run.localProfileCommit);
    if (run.state !== "awaiting_promotion" && !retryingLocalVerification) {
      throw new Error("Create/Improve candidate is not awaiting promotion.");
    }
    const candidate = requireRunCandidate(run, action.candidateId);
    if (candidate.status !== "evaluated" || !candidate.git?.headCommit) {
      throw new Error("Create/Improve candidate must be committed and evaluated before it can be applied.");
    }
    if (run.tasksetRef && (
      candidate.tasksetRef?.id !== run.tasksetRef.id
      || candidate.tasksetRef.revision !== run.tasksetRef.revision
      || candidate.tasksetRef.contentHash !== run.tasksetRef.contentHash
    )) {
      throw new Error("Create/Improve candidate is not linked to the exact approved Taskset revision.");
    }
    const candidateReceipts = run.evaluationReceipts.filter(
      (receipt) => receipt.candidateId === candidate.id && receipt.subject === "candidate",
    );
    if (
      candidateReceipts.length === 0 ||
      candidateReceipts.some(
        (receipt) => receipt.status !== "passed" || receipt.publishGate === "failed",
      )
    ) {
      throw new Error("Create/Improve candidate requires passing Eval receipts before it can be applied.");
    }
    if (run.tasksetRef && candidateReceipts.some((receipt) =>
      receipt.tasksetId !== run.tasksetRef!.id
      || receipt.tasksetHash !== run.tasksetRef!.contentHash
      || receipt.metadata.trustedTasksetExecution !== true
      || typeof receipt.metadata.executionContractHash !== "string"
    )) {
      throw new Error("Create/Improve candidate requires a trusted receipt for the exact approved Taskset revision.");
    }
    return nextCreateImproveRunRevision(run, {
      state: action.type === "apply_candidate" ? "reconciling_release" : "opening_pull_request",
      releaseOutcome: {
        ...run.releaseOutcome,
        status: "pending",
        updatedAt: timestamp,
      },
      blockedReason: null,
      metadata: {
        ...run.metadata,
        releaseAction: {
          type: action.type,
          candidateId: candidate.id,
          requestedAt: timestamp,
        },
      },
      updatedAt: timestamp,
    }, action.actionId);
  }
  if (action.type === "reconcile_pull_request") {
    if (!["pull_request_open", "blocked"].includes(run.state)) {
      throw new Error("Create/Improve run has no open PR to reconcile.");
    }
    const candidate = requireRunCandidate(run, action.candidateId);
    if (!candidate.git?.pullRequest) {
      throw new Error("Create/Improve candidate has no PR to reconcile.");
    }
    if (run.state === "blocked" && candidate.git.pullRequest.state !== "merged") {
      throw new Error("Only a merged PR with failed verification can be reconciled from a blocked run.");
    }
    return nextCreateImproveRunRevision(run, {
      state: "reconciling_release",
      blockedReason: null,
      metadata: {
        ...run.metadata,
        releaseAction: {
          type: action.type,
          candidateId: candidate.id,
          requestedAt: timestamp,
        },
      },
      updatedAt: timestamp,
    }, action.actionId);
  }
  if (action.type === "reject_candidate") {
    if (!["awaiting_promotion", "pull_request_open"].includes(run.state)) {
      throw new Error("Create/Improve candidate is not available for rejection.");
    }
    const candidate = requireRunCandidate(run, action.candidateId);
    const reason = action.reason?.trim() || "Candidate rejected.";
    if (candidate.git?.pullRequest) {
      return nextCreateImproveRunRevision(run, {
        state: "reconciling_release",
        blockedReason: null,
        metadata: {
          ...run.metadata,
          releaseAction: {
            type: action.type,
            candidateId: candidate.id,
            reason,
            requestedAt: timestamp,
          },
        },
        updatedAt: timestamp,
      }, action.actionId);
    }
    return nextCreateImproveRunRevision(run, {
      state: "rejected",
      candidates: run.candidates.map((item) =>
        item.id === candidate.id
          ? { ...item, status: "rejected" as const, updatedAt: timestamp }
          : item,
      ),
      releaseOutcome: {
        ...run.releaseOutcome,
        status: "rejected",
        updatedAt: timestamp,
      },
      blockedReason: reason,
      metadata: {
        ...run.metadata,
        releaseAction: {
          type: action.type,
          candidateId: candidate.id,
          reason,
          completedAt: timestamp,
        },
      },
      updatedAt: timestamp,
    }, action.actionId);
  }
  if (action.type === "pause") {
    if (!run.executionPolicy.pauseAllowed) {
      throw new Error("This Create/Improve run cannot be paused.");
    }
    if (["ready", "ready_local", "published_hosted", "cancelled"].includes(run.state)) {
      throw new Error("Completed Create/Improve runs cannot be paused.");
    }
    return nextCreateImproveRunRevision(run, {
      state: "paused",
      metadata: { ...run.metadata, pausedFromState: run.state, pausedAt: timestamp },
      updatedAt: timestamp,
    }, action.actionId);
  }
  const resumeState = resumeStateFromMetadata(run);
  return nextCreateImproveRunRevision(run, {
    state: resumeState,
    metadata: { ...run.metadata, resumedAt: timestamp },
    updatedAt: timestamp,
  }, action.actionId);
}

function requireRunCandidate(
  run: CreateImproveRun,
  candidateId: string,
): CreateImproveRun["candidates"][number] {
  const candidate = run.candidates.find((item) => item.id === candidateId);
  if (!candidate) {
    throw new Error(`Create/Improve candidate not found: ${candidateId}`);
  }
  return candidate;
}

export function createPlanExecutionRunForApprovedAdapter(
  run: CreateImproveRun,
  session: Session,
): CreateImproveRun {
  if (
    run.state !== "applying_source" ||
    run.plan?.status !== "approved" ||
    run.adapter.kind === "local"
  ) {
    return run;
  }
  const target = resolveWorkspaceExecutionTarget({ session });
  const adapterKind = run.adapter.kind;
  const reason = adapterKind === "hosted"
    ? "Approved hosted Create/Improve plans from this chat require the Cloud work item background flow. No local source mutation was performed."
    : "Approved Profile promotion requires an explicit Cloud promotion flow. No local source mutation was performed.";
  return nextCreateImproveRunRevision(run, {
    state: "blocked",
    blockedReason: reason,
    metadata: {
      ...run.metadata,
      createImproveApproval: {
        status: "blocked",
        reason: adapterKind === "hosted"
          ? "hosted_create_improve_apply_not_configured"
          : "promote_local_to_hosted_apply_not_configured",
        adapterKind,
        workspaceExecutionTarget: createImproveExecutionTargetMetadata(target),
      },
    },
    updatedAt: now(),
  });
}

export function createImproveExecutionTargetMetadata(
  target: ReturnType<typeof resolveWorkspaceExecutionTarget>,
): Record<string, unknown> {
  if (target.target === "sandbox") {
    return {
      target: target.target,
      ready: target.ready,
      workspaceKind: target.workspaceKind,
      workspaceId: target.workspaceId,
      sandboxId: target.sandboxId,
      cloudProjectId: target.cloudProjectId,
      localProjectId: target.localProjectId,
      hybrid: target.hybrid,
      reason: target.reason,
    };
  }
  if (target.target === "local") {
    return {
      target: target.target,
      ready: target.ready,
      workspaceKind: target.workspaceKind,
      workspaceId: target.workspaceId,
      localProjectId: target.localProjectId,
      cwd: target.cwd,
      reason: target.reason,
    };
  }
  return {
    target: target.target,
    ready: target.ready,
    workspaceKind: target.workspaceKind,
    workspaceId: target.workspaceId,
    reason: target.reason,
  };
}

export function createImproveRuntimeEventStatus(
  run: CreateImproveRun,
): RuntimeEvent["status"] {
  if (["awaiting_questions", "awaiting_plan_approval", "awaiting_promotion", "pull_request_open", "paused"].includes(run.state)) return "pending";
  if (["applying_source", "running_checks", "evaluating", "opening_pull_request", "reconciling_release", "pushing_hosted", "running_hosted_checks"].includes(run.state)) {
    return "started";
  }
  if (["rejected", "blocked", "failed", "cancelled"].includes(run.state)) return "failed";
  return "completed";
}

export function createImproveBackgroundFailureRun(
  run: CreateImproveRun,
  message: string,
): CreateImproveRun {
  return nextCreateImproveRunRevision(run, {
    state: "blocked",
    blockedReason: message,
    metadata: {
      ...run.metadata,
      localCreateImprove: {
        status: "blocked",
        reason: "local_create_improve_background_apply_failed",
      },
    },
    updatedAt: now(),
  });
}

export function normalizeMentionedSandboxToolRequest(input: {
  request: WorkspaceToolRequest;
  mentionedApps: OpenPondApp[];
  userPrompt: string;
}): WorkspaceToolRequest {
  void input.mentionedApps;
  void input.userPrompt;
  return input.request;
}

export function withCreateImproveRun(turn: Turn, run: CreateImproveRun | null): Turn {
  return {
    ...turn,
    metadata: { ...(turn.metadata ?? {}), createImproveRun: run },
    createImproveRun: run,
  };
}

function resumeStateFromMetadata(run: CreateImproveRun): CreateImproveRun["state"] {
  if (
    run.state === "blocked"
    && run.operation === "improve"
    && run.target.kind === "agent"
    && run.candidates.some((candidate) =>
      Boolean(candidate.git?.worktreePath)
      && ["draft", "checking"].includes(candidate.status),
    )
  ) {
    return "applying_source";
  }
  if (run.state !== "paused") throw new Error("Create/Improve run cannot be resumed.");
  const parsed = CreateImproveRunSchema.shape.state.safeParse(run.metadata.pausedFromState);
  if (!parsed.success || parsed.data === "paused") return "planning";
  return parsed.data;
}
