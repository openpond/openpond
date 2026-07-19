import type { CreateImproveRun } from "@openpond/contracts";

export const CREATE_IMPROVE_MUTATION_APPROVED_STATES = new Set<CreateImproveRun["state"]>([
  "applying_source",
  "running_checks",
  "evaluating",
  "awaiting_promotion",
  "opening_pull_request",
  "pull_request_open",
  "reconciling_release",
  "released",
  "ready",
  "ready_local",
  "pushing_hosted",
  "running_hosted_checks",
  "published_hosted",
]);

export function isCreateImproveMutationState(state: CreateImproveRun["state"]): boolean {
  return CREATE_IMPROVE_MUTATION_APPROVED_STATES.has(state);
}

export function assertCreateImproveRunLinked(input: {
  actionLabel?: string;
  run?: CreateImproveRun | null;
}): void {
  const run = input.run;
  if (!run) return;
  const actionLabel = input.actionLabel ?? "Create/Improve update";
  if (run.plan && run.plan.runId !== run.id) {
    throw new Error(`${actionLabel} requires a plan linked to the submitted run.`);
  }
  if (run.workflowCapture && run.workflowCapture.runId !== run.id) {
    throw new Error(`${actionLabel} requires workflow capture linked to the submitted run.`);
  }
  if (run.plan?.approvalId && !run.approvalIds.includes(run.plan.approvalId)) {
    throw new Error(`${actionLabel} requires the plan approval id in the run.`);
  }
}

export function assertCreateImproveMutationApproved(input: {
  actionLabel?: string;
  run?: CreateImproveRun | null;
}): void {
  const actionLabel = input.actionLabel ?? "Create/Improve mutation";
  const run = input.run;
  if (!run) throw new Error(`${actionLabel} requires a Create/Improve run.`);
  assertCreateImproveRunLinked({ actionLabel, run });
  if (!isCreateImproveMutationState(run.state)) {
    throw new Error(`${actionLabel} cannot start before plan approval.`);
  }
  if (run.plan?.status !== "approved") {
    throw new Error(`${actionLabel} requires an approved plan.`);
  }
}
