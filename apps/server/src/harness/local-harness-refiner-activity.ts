import type {
  RefinementTriggerDecision,
  Session,
} from "@openpond/contracts";
import {
  HarnessRefinerEvidenceBasisSchema,
  type HarnessRefinerEvidenceBasis,
  type ImmutableReleaseRef,
} from "@openpond/harness";

import type { LocalHarnessRefinerWorkerResult } from "./local-harness-refiner-worker.js";

type ActivityResult = "no_action" | "routed" | "applied" | "retained";

export type LocalHarnessRefinerActivityDisplay = {
  schemaVersion: "openpond.localHarnessRefinerActivityDisplay.v1";
  visibility: "always" | "material_only";
  state: "completed";
  workspaceId: string;
  result: ActivityResult;
  decision: "no_action" | "route" | "propose";
  route: string | null;
  operation: "create" | "update" | "delete" | null;
  target: string | null;
  summary: string;
  expectedOutcome: string | null;
  reason: string;
  evidenceBasis: HarnessRefinerEvidenceBasis | null;
  critiqueStatus: "not_applicable" | "passed";
  validationStatus: "not_applicable" | "pending" | "passed" | "failed";
  validationReceipts: Array<{
    id: string;
    contentHash: string;
    status: "passed" | "failed" | "blocked" | "skipped";
    summary: string;
  }>;
  edits: Array<{
    id: string;
    operation: "create" | "update" | "delete";
    target: string;
    summary: string;
    content: string | null;
  }>;
  trigger: ImmutableReleaseRef;
  outcome: ImmutableReleaseRef;
  proposal: ImmutableReleaseRef | null;
  applyReceipt: ImmutableReleaseRef | null;
  advanceReceipt: ImmutableReleaseRef | null;
  inputHarness: ImmutableReleaseRef;
  outputHarness: ImmutableReleaseRef | null;
};

export function localHarnessRefinerActivityDisplay(input: {
  session: Session;
  trigger: RefinementTriggerDecision;
  result: LocalHarnessRefinerWorkerResult;
}): LocalHarnessRefinerActivityDisplay {
  const proposal = input.result.proposal;
  const primaryEdit = proposal?.edits.find((edit) => edit.target !== "harness.json")
    ?? proposal?.edits[0]
    ?? null;
  const routed = input.result.outcome.metadata.routed === true;
  const result: ActivityResult = proposal
    ? input.result.applyReceipt?.decision === "applied"
      ? "applied"
      : "retained"
    : routed
      ? "routed"
      : "no_action";
  const inputHarness = proposal?.baseHarnessRelease ?? input.trigger.harnessRelease;
  const outputHarness = result === "applied"
    ? input.result.advanceReceipt?.nextRelease ?? inputHarness
    : null;

  return {
    schemaVersion: "openpond.localHarnessRefinerActivityDisplay.v1",
    visibility: isEvaluationSession(input.session) ? "always" : "material_only",
    state: "completed",
    workspaceId: input.result.workspace.id,
    result,
    decision: proposal ? "propose" : routed ? "route" : "no_action",
    route: proposal?.route ?? stringMetadata(input.result.outcome.metadata.route),
    operation: primaryEdit?.operation ?? null,
    target: primaryEdit?.target ?? null,
    summary: primaryEdit?.summary
      ?? stringMetadata(input.result.outcome.metadata.summary)
      ?? resultSummary(result, proposal?.route ?? stringMetadata(input.result.outcome.metadata.route)),
    expectedOutcome: proposal?.expectedOutcome
      ?? stringMetadata(input.result.outcome.metadata.expectedOutcome),
    reason: input.result.outcome.reason,
    evidenceBasis: evidenceBasisFromResult(input.result),
    critiqueStatus: proposal ? "passed" : "not_applicable",
    validationStatus: proposalValidationStatus(input.result),
    validationReceipts: input.result.validations.map((validation) => ({
      id: validation.id,
      contentHash: validation.contentHash,
      status: validation.status,
      summary: validation.summary,
    })),
    edits: proposal?.edits.map((edit) => ({
      id: edit.id,
      operation: edit.operation,
      target: edit.target,
      summary: edit.summary,
      content: edit.content,
    })) ?? [],
    trigger: { id: input.trigger.id, contentHash: input.trigger.contentHash },
    outcome: { id: input.result.outcome.id, contentHash: input.result.outcome.contentHash },
    proposal: proposal ? { id: proposal.id, contentHash: proposal.contentHash } : null,
    applyReceipt: input.result.applyReceipt
      ? { id: input.result.applyReceipt.id, contentHash: input.result.applyReceipt.contentHash }
      : null,
    advanceReceipt: input.result.advanceReceipt
      ? { id: input.result.advanceReceipt.id, contentHash: input.result.advanceReceipt.contentHash }
      : null,
    inputHarness,
    outputHarness,
  };
}

function evidenceBasisFromResult(
  result: LocalHarnessRefinerWorkerResult,
): HarnessRefinerEvidenceBasis | null {
  const candidate = result.proposal?.metadata.evidenceBasis
    ?? result.outcome.metadata.evidenceBasis;
  const parsed = HarnessRefinerEvidenceBasisSchema.safeParse(candidate);
  return parsed.success ? parsed.data : null;
}

function proposalValidationStatus(
  result: LocalHarnessRefinerWorkerResult,
): LocalHarnessRefinerActivityDisplay["validationStatus"] {
  if (!result.proposal) return "not_applicable";
  const byId = new Map(result.validations.map((validation) => [validation.validationId, validation]));
  const required = result.proposal.validationPlan.filter((validation) => validation.required);
  if (required.some((validation) => !byId.has(validation.id))) return "pending";
  return required.every((validation) => byId.get(validation.id)?.status === "passed")
    ? "passed"
    : "failed";
}

function isEvaluationSession(session: Session): boolean {
  return session.metadata?.automatedTasksetWorkAttempt === true
    || typeof session.metadata?.tasksetId === "string"
    || typeof session.metadata?.benchmarkRuntime === "string";
}

function stringMetadata(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function resultSummary(result: ActivityResult, route: string | null): string {
  if (result === "no_action") return "No reusable change";
  if (result === "routed") return route ? `${titleCase(route)} issue routed` : "Issue routed";
  if (result === "applied") return route ? `${titleCase(route)} change` : "Harness change";
  return route ? `${titleCase(route)} change` : "Harness change";
}

function titleCase(value: string): string {
  return value.length > 0 ? `${value[0]!.toUpperCase()}${value.slice(1)}` : value;
}
