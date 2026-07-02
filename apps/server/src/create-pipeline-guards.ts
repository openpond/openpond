import type { CreatePipelineRequest, CreatePipelineSnapshot } from "@openpond/contracts";

export const CREATE_PIPELINE_MUTATION_APPROVED_STATES = new Set<CreatePipelineSnapshot["state"]>([
  "applying_source",
  "running_checks",
  "ready_local",
  "pushing_hosted",
  "running_hosted_checks",
  "published_hosted",
]);

export function isCreatePipelineMutationState(state: CreatePipelineSnapshot["state"]): boolean {
  return CREATE_PIPELINE_MUTATION_APPROVED_STATES.has(state);
}

export function assertCreatePipelineSnapshotLinked(input: {
  actionLabel?: string;
  request?: CreatePipelineRequest | null;
  snapshot?: CreatePipelineSnapshot | null;
}): void {
  const snapshot = input.snapshot;
  if (!snapshot) return;
  const actionLabel = input.actionLabel ?? "Create pipeline update";
  const request = input.request ?? snapshot.request;
  if (snapshot.request.id !== request.id) {
    throw new Error(`${actionLabel} requires a snapshot for the submitted request.`);
  }
  if (snapshot.plan && snapshot.plan.requestId !== request.id) {
    throw new Error(`${actionLabel} requires a plan for the submitted request.`);
  }
  if (snapshot.workflowCapture && snapshot.workflowCapture.requestId !== request.id) {
    throw new Error(`${actionLabel} requires workflow capture for the submitted request.`);
  }
  if (snapshot.plan?.approvalId && !snapshot.approvalIds.includes(snapshot.plan.approvalId)) {
    throw new Error(`${actionLabel} requires the plan approval id in the snapshot.`);
  }
}

export function assertCreatePipelineMutationApproved(input: {
  actionLabel?: string;
  request?: CreatePipelineRequest | null;
  snapshot?: CreatePipelineSnapshot | null;
}): void {
  if (!input.request) return;
  const actionLabel = input.actionLabel ?? "Create pipeline mutation";
  const snapshot = input.snapshot;
  if (!snapshot) {
    throw new Error(`${actionLabel} requires an approved create plan snapshot.`);
  }
  assertCreatePipelineSnapshotLinked({ actionLabel, request: input.request, snapshot });
  if (!isCreatePipelineMutationState(snapshot.state)) {
    throw new Error(`${actionLabel} cannot start before plan approval.`);
  }
  if (snapshot.plan?.status !== "approved") {
    throw new Error(`${actionLabel} requires an approved plan.`);
  }
}
