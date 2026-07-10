import {
  CreatePipelineSnapshotSchema,
  type Approval,
  type CreatePipelineRequest,
  type CreatePipelineSnapshot,
  type OpenPondApp,
  type RuntimeEvent,
  type SendTurnRequest,
  type Session,
  type Turn,
  type WorkspaceToolRequest,
} from "@openpond/contracts";
import { now } from "../../utils.js";
import { resolveWorkspaceExecutionTarget } from "../../workspace/workspace-execution-target.js";

export function shouldRunCreatePipelinePlanner(snapshot: CreatePipelineSnapshot): boolean {
  return snapshot.state === "planning" && !snapshot.plan;
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
    data: {
      kind: "thread_goal",
      provider,
      goal: record,
    },
  };
}

type CreatePipelinePlanStatus = NonNullable<CreatePipelineSnapshot["plan"]>["status"];

export function approvalStatusForPlan(status: CreatePipelinePlanStatus): Approval["status"] {
  if (status === "approved") return "accepted";
  if (status === "rejected") return "declined";
  if (status === "cancelled") return "cancelled";
  return "pending";
}

export function createPlanApproval(input: {
  existing?: Approval | null;
  session: Session;
  turn: Turn;
  request: CreatePipelineRequest;
  snapshot: CreatePipelineSnapshot;
  status: Approval["status"];
}): Approval {
  const plan = input.snapshot.plan;
  const createdAt = input.existing?.createdAt ?? input.snapshot.createdAt;
  return {
    id: plan?.approvalId ?? `approval_${input.snapshot.id}`,
    sessionId: input.session.id,
    turnId: input.turn.id,
    providerRequestId: input.snapshot.id,
    kind: "create_plan",
    title: `${input.request.operation === "edit" ? "Approve edit plan" : "Approve create plan"}: ${input.request.objective}`,
    detail: JSON.stringify(
      {
        requestId: input.request.id,
        pipelineId: input.snapshot.id,
        planId: plan?.id ?? null,
        objective: input.request.objective,
        summary: plan?.summary ?? null,
        sourcePlan: plan?.sourcePlan ?? [],
        requirements: plan?.requirements ?? [],
        checks: plan?.checks ?? [],
        workflowCaptureId: input.snapshot.workflowCapture?.id ?? null,
      },
      null,
      2,
    ),
    status: input.status,
    createdAt,
  };
}

export function createPlanDecisionSnapshot(
  snapshot: CreatePipelineSnapshot,
  decision: "accept" | "acceptForSession" | "decline" | "cancel",
): CreatePipelineSnapshot {
  const timestamp = now();
  const approved = decision === "accept" || decision === "acceptForSession";
  const cancelled = decision === "cancel";
  const blockedReason = approved
    ? null
    : cancelled
      ? "Create plan cancelled before source mutation."
      : "Create plan rejected before source mutation.";
  return CreatePipelineSnapshotSchema.parse({
    ...snapshot,
    state: approved ? "applying_source" : "blocked",
    plan: snapshot.plan
      ? {
          ...snapshot.plan,
          status: approved ? "approved" : cancelled ? "cancelled" : "rejected",
          approvedAt: approved ? snapshot.plan.approvedAt ?? timestamp : null,
          metadata: approved
            ? snapshot.plan.metadata
            : {
                ...snapshot.plan.metadata,
                blockedReason,
              },
          updatedAt: timestamp,
        }
      : null,
    blockedReason,
    updatedAt: timestamp,
  });
}

export function createPlanExecutionSnapshotForApprovedAdapter(
  snapshot: CreatePipelineSnapshot,
  session: Session,
): CreatePipelineSnapshot {
  if (
    snapshot.state !== "applying_source" ||
    snapshot.plan?.status !== "approved" ||
    snapshot.request.adapter.kind === "local"
  ) {
    return snapshot;
  }
  const target = resolveWorkspaceExecutionTarget({ session });
  const adapterKind = snapshot.request.adapter.kind;
  const reason = adapterKind === "hosted"
    ? "Approved hosted Create plans from this chat require the Cloud work item background flow. No local source mutation was performed."
    : "Approved promote-to-hosted Create plans require an explicit Cloud promotion flow. No local source mutation was performed.";
  return CreatePipelineSnapshotSchema.parse({
    ...snapshot,
    state: "blocked",
    blockedReason: reason,
    metadata: {
      ...snapshot.metadata,
      createPipelineApproval: {
        status: "blocked",
        reason: adapterKind === "hosted"
          ? "hosted_create_pipeline_apply_not_configured"
          : "promote_local_to_hosted_apply_not_configured",
        adapterKind,
        workspaceExecutionTarget: createPipelineExecutionTargetMetadata(target),
      },
    },
    updatedAt: now(),
  });
}

export function createPipelineExecutionTargetMetadata(
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

export function createPipelineRuntimeEventStatus(
  snapshot: CreatePipelineSnapshot,
): RuntimeEvent["status"] {
  if (snapshot.state === "awaiting_questions" || snapshot.state === "awaiting_plan_approval") return "pending";
  if (
    snapshot.state === "applying_source" ||
    snapshot.state === "running_checks" ||
    snapshot.state === "pushing_hosted" ||
    snapshot.state === "running_hosted_checks"
  ) {
    return "started";
  }
  if (snapshot.state === "blocked" || snapshot.state === "failed" || snapshot.state === "cancelled") {
    return "failed";
  }
  return "completed";
}

export function createPipelineBackgroundFailureSnapshot(
  snapshot: CreatePipelineSnapshot,
  message: string,
): CreatePipelineSnapshot {
  return CreatePipelineSnapshotSchema.parse({
    ...snapshot,
    state: "blocked",
    blockedReason: message,
    metadata: {
      ...snapshot.metadata,
      localCreatePipeline: {
        status: "blocked",
        reason: "local_create_background_apply_failed",
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
