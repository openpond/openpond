import path from "node:path";
import type { SubagentRun } from "@openpond/contracts";
import { recordFromUnknown, stringFromRecord } from "../turns/value-utils.js";

const RETAINED_WORKSPACE_DAYS = 7;
const RETAINED_WORKSPACE_MS = RETAINED_WORKSPACE_DAYS * 24 * 60 * 60 * 1000;

export type SubagentWorkspaceRetentionTrigger =
  | "auto_after_acceptance"
  | "cancel_requested"
  | "manual_cleanup"
  | "patch_approval_declined"
  | "patch_approval_cancelled";

export type SubagentCleanupPolicy =
  | "auto_after_acceptance"
  | "cancel_requested"
  | "manual_cleanup"
  | "retention_expired";

export function subagentCleanupRetainReason(run: SubagentRun, policy: SubagentCleanupPolicy): string | null {
  if (policy === "cancel_requested" || policy === "retention_expired") return null;
  const handoff = workspaceHandoffFromRun(run);
  const changed = handoff ? truthyRecordBoolean(handoff, "changed") : false;
  const applyResult = recordFromUnknown(handoff?.applyResult);
  const applied = applyResult ? stringFromRecord(applyResult, "status") === "applied" : false;
  if (changed && !applied) return "Changed child workspace has not been applied; retain for inspection.";
  if (run.status === "failed" || run.status === "failed_with_artifacts") {
    return "Failed child workspace retained for inspection.";
  }
  return null;
}

export function subagentRetainedWorkspaceState(input: {
  retainedAt: string;
  reason: string;
  trigger: SubagentWorkspaceRetentionTrigger;
}): Record<string, unknown> {
  return {
    status: "retained",
    reason: input.reason,
    retainedAt: input.retainedAt,
    retentionPolicy: {
      kind: "retain_for_inspection",
      retentionDays: RETAINED_WORKSPACE_DAYS,
      expiresAt: addMillisecondsToIso(input.retainedAt, RETAINED_WORKSPACE_MS),
      cleanupAfterExpiry: true,
      trigger: input.trigger,
    },
  };
}

export function subagentWorkspaceRetentionTriggerForCleanupPolicy(
  policy: SubagentCleanupPolicy,
): SubagentWorkspaceRetentionTrigger {
  return policy === "retention_expired" ? "manual_cleanup" : policy;
}

export function subagentCleanupOutput(run: SubagentRun, workspaceCleanup: Record<string, unknown>): string {
  const status = stringFromRecord(workspaceCleanup, "status") ?? "unknown";
  if (status === "removed") return `${run.roleId} subagent isolated workspace cleaned up.`;
  if (status === "deleted") return `${run.roleId} subagent isolated sandbox fork deleted.`;
  if (status === "retained") return `${run.roleId} subagent workspace retained for inspection.`;
  if (status === "failed") return `${run.roleId} subagent cleanup failed.`;
  return `${run.roleId} subagent cleanup ${status}.`;
}

export function subagentWorkspaceCleanupAlreadyDone(workspaceCleanup: Record<string, unknown>): boolean {
  const status = stringFromRecord(workspaceCleanup, "status");
  return status === "removed" || status === "deleted";
}

export function workspaceHandoffFromRun(run: SubagentRun): Record<string, unknown> | null {
  return recordFromUnknown(recordFromUnknown(run.metadata)?.workspaceHandoff);
}

export function truthyRecordBoolean(record: Record<string, unknown>, key: string): boolean {
  return record[key] === true;
}

export function truncateApprovalTitle(value: string): string {
  const normalized = value.replace(/\s+/g, " ").trim();
  return normalized.length <= 88 ? normalized : `${normalized.slice(0, 85)}...`;
}

export function assertPathInside(input: { rootPath: string; targetPath: string; label: string }): void {
  const rootPath = path.resolve(input.rootPath);
  const targetPath = path.resolve(input.targetPath);
  const relative = path.relative(rootPath, targetPath);
  if (relative && !relative.startsWith("..") && !path.isAbsolute(relative)) return;
  throw new Error(`${input.label} path must stay inside the isolated subagent workspace.`);
}

function addMillisecondsToIso(iso: string, ms: number): string {
  const parsed = Date.parse(iso);
  return new Date((Number.isFinite(parsed) ? parsed : Date.now()) + ms).toISOString();
}
