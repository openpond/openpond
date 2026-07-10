import {
  ResolveApprovalRequestSchema,
  SubagentProgressSchema,
  SubagentReviewStateSchema,
  SubagentRunSchema,
  type Approval,
  type ResolveApprovalRequest,
  type RuntimeEvent,
  type Session,
  type SubagentRun,
} from "@openpond/contracts";
import { runWorkspaceCommand } from "../../workspace/workspaces.js";
import { event, now } from "../../utils.js";
import type { TurnRunnerDependencies } from "../turns/ports.js";
import { stringFromRecord, uniqueNonEmptyStrings } from "../turns/value-utils.js";
import {
  assertPathInside,
  subagentRetainedWorkspaceState,
  truncateApprovalTitle,
  truthyRecordBoolean,
  workspaceHandoffFromRun,
} from "./workspace-state.js";

type AppendSubagentReceipt = (input: {
  parentSession: Session;
  parentTurnId?: string | null;
  run: SubagentRun;
  childSession?: Session | null;
  eventName: Extract<RuntimeEvent["name"], `subagent.${string}`>;
  status: RuntimeEvent["status"];
  output: string;
}) => Promise<void>;

export function createSubagentPatchApprovalRuntime(deps: {
  getApproval(approvalId: string): Promise<Approval | null>;
  getSubagentRun?: ((runId: string) => Promise<SubagentRun | null>) | null;
  canPersistSubagentRun: boolean;
  getSession: TurnRunnerDependencies["getSession"];
  upsertSubagentRunAndNotify(run: SubagentRun): Promise<unknown>;
  upsertApproval(approval: Approval): Promise<void>;
  appendRuntimeEvent: TurnRunnerDependencies["appendRuntimeEvent"];
  appendSubagentReceipt: AppendSubagentReceipt;
  appendWorkspaceDiffEvent: TurnRunnerDependencies["appendWorkspaceDiffEvent"];
  cleanupSubagentRun(input: {
    run: SubagentRun;
    parentSession: Session;
    parentTurnId?: string | null;
    reason: string;
    policy: "auto_after_acceptance";
  }): Promise<{ run: SubagentRun; workspaceCleanup: Record<string, unknown> }>;
}) {
  async function resolveSubagentPatchApplyApproval(
    approvalId: string,
    payload: unknown,
  ): Promise<Approval | null> {
    const input = ResolveApprovalRequestSchema.parse(payload);
    const approval = await deps.getApproval(approvalId);
    if (!approval || approval.kind !== "subagent_patch_apply") return null;
    if (approval.status !== "pending") throw new Error("Approval not found or already resolved");
    if (!deps.getSubagentRun || !deps.canPersistSubagentRun) {
      throw new Error("Subagent runtime dependencies are not available.");
    }
    const run = await deps.getSubagentRun(String(approval.providerRequestId));
    if (!run) throw new Error(`Subagent run ${approval.providerRequestId} was not found.`);
    const session = await deps.getSession(approval.sessionId);
    const parentTurnId = approval.turnId ?? run.parentTurnId;
    if (!parentTurnId) throw new Error("Subagent patch approval is missing its parent turn.");
    const accepted = input.decision === "accept" || input.decision === "acceptForSession";
    const status = approvalStatusForDecision(input.decision);
    const decidedAt = now();
    let nextRun: SubagentRun;
    if (accepted) {
      const applyResult = await applySubagentPatchApproval({ approval, run });
      nextRun = SubagentRunSchema.parse({
        ...run,
        status: "accepted",
        completedAt: decidedAt,
        report: run.report ? { ...run.report, followUpNeeded: false } : run.report,
        progress: SubagentProgressSchema.parse({
          ...(run.progress ?? {}),
          latestMeaningfulActivity: "Parent accepted the child review packet and applied the patch.",
          currentBlocker: null,
          updatedAt: decidedAt,
        }),
        review: SubagentReviewStateSchema.parse({
          ...(run.review ?? {}),
          status: "accepted",
          decidedAt,
          summary: run.report?.summary ?? run.review.summary ?? null,
        }),
        metadata: {
          ...(run.metadata ?? {}),
          workspaceHandoff: { ...(workspaceHandoffFromRun(run) ?? {}), applyResult },
        },
      });
    } else {
      const revisionMessage = input.decision === "cancel"
        ? "Parent cancelled the patch approval."
        : "Parent declined the patch approval; the child submission needs revision before acceptance.";
      const workspaceRetention = subagentRetainedWorkspaceState({
        retainedAt: decidedAt,
        reason: input.decision === "cancel"
          ? "Patch approval cancelled; child workspace retained for inspection."
          : "Patch approval declined; child workspace retained for revision.",
        trigger: input.decision === "cancel" ? "patch_approval_cancelled" : "patch_approval_declined",
      });
      nextRun = SubagentRunSchema.parse({
        ...run,
        status: input.decision === "cancel" ? "cancelled" : "needs_revision",
        completedAt: input.decision === "cancel" ? decidedAt : null,
        error: input.decision === "cancel" ? revisionMessage : run.error,
        report: run.report ? { ...run.report, followUpNeeded: input.decision !== "cancel" } : run.report,
        progress: SubagentProgressSchema.parse({
          ...(run.progress ?? {}),
          latestMeaningfulActivity: revisionMessage,
          currentBlocker: input.decision === "cancel" ? revisionMessage : null,
          updatedAt: decidedAt,
        }),
        review: SubagentReviewStateSchema.parse({
          ...(run.review ?? {}),
          status: input.decision === "cancel" ? "needs_user_input" : "needs_revision",
          decidedAt,
          issues: uniqueNonEmptyStrings([...(run.review.issues ?? []), revisionMessage]),
          requiredCorrections: input.decision === "cancel"
            ? run.review.requiredCorrections
            : uniqueNonEmptyStrings([
                ...(run.review.requiredCorrections ?? []),
                "Revise the submitted patch or provide a replacement plan before acceptance.",
              ]),
          humanReviewRecommended: true,
        }),
        metadata: {
          ...(run.metadata ?? {}),
          workspaceHandoff: {
            ...(workspaceHandoffFromRun(run) ?? {}),
            applyResult: {
              status: input.decision === "cancel" ? "cancelled" : "declined",
              approvalId: approval.id,
              decidedAt,
              workspaceRetention,
            },
          },
        },
      });
    }
    await deps.upsertSubagentRunAndNotify(nextRun);
    const resolved: Approval = { ...approval, status };
    await deps.upsertApproval(resolved);
    await deps.appendRuntimeEvent(event({
      sessionId: approval.sessionId,
      turnId: approval.turnId ?? undefined,
      name: "approval.resolved",
      source: "server",
      action: "subagent_patch_apply",
      appId: session.appId,
      status: accepted ? "completed" : "failed",
      output: approval.title,
      data: { approvalId, status, decision: input.decision, runId: nextRun.id, childSessionId: nextRun.childSessionId },
    }));
    await deps.appendSubagentReceipt({
      parentSession: session,
      parentTurnId,
      run: nextRun,
      eventName: accepted ? "subagent.accepted" : input.decision === "cancel" ? "subagent.cancelled" : "subagent.needs_revision",
      status: accepted ? "completed" : "failed",
      output: accepted
        ? `${run.roleId} subagent patch applied to the parent workspace.`
        : `${run.roleId} subagent patch was ${status}.`,
    });
    if (!accepted) {
      await deps.appendSubagentReceipt({
        parentSession: session,
        parentTurnId,
        run: nextRun,
        eventName: "subagent.workspace_retained",
        status: "completed",
        output: input.decision === "cancel"
          ? `${run.roleId} subagent workspace retained after patch approval cancellation.`
          : `${run.roleId} subagent workspace retained for patch revision.`,
      });
    } else {
      await deps.appendWorkspaceDiffEvent(session, parentTurnId).catch(() => undefined);
      await deps.cleanupSubagentRun({
        run: nextRun,
        parentSession: session,
        parentTurnId,
        reason: "accepted_patch_applied",
        policy: "auto_after_acceptance",
      });
    }
    return resolved;
  }

  async function requestSubagentPatchApplyApproval(input: {
    parentSession: Session;
    parentTurnId: string;
    run: SubagentRun;
  }): Promise<Approval | null> {
    const handoff = workspaceHandoffFromRun(input.run);
    if (!handoff || !truthyRecordBoolean(handoff, "changed")) return null;
    const patchPath = stringFromRecord(handoff, "patchPath");
    const parentRepoPath = stringFromRecord(handoff, "parentRepoPath");
    if (!patchPath || !parentRepoPath) return null;
    const approvalId = `approval_subagent_patch_${input.run.id}`;
    const existing = await deps.getApproval(approvalId);
    if (existing) return existing;
    const approval: Approval = {
      id: approvalId,
      sessionId: input.parentSession.id,
      turnId: input.parentTurnId,
      providerRequestId: input.run.id,
      kind: "subagent_patch_apply",
      title: `Apply ${input.run.roleId} subagent patch: ${truncateApprovalTitle(input.run.objective)}`,
      detail: JSON.stringify({
        runId: input.run.id,
        roleId: input.run.roleId,
        childSessionId: input.run.childSessionId,
        parentGoalId: input.run.parentGoalId,
        objective: input.run.objective,
        summary: input.run.report?.summary ?? null,
        parentRepoPath,
        patchPath,
        branch: handoff.branch ?? null,
        baseCommit: handoff.baseCommit ?? null,
        patchBytes: handoff.patchBytes ?? null,
        patchPreview: handoff.patchPreview ?? null,
        patchTruncated: handoff.patchTruncated ?? null,
      }, null, 2),
      status: "pending",
      createdAt: now(),
    };
    await deps.upsertApproval(approval);
    await deps.appendRuntimeEvent(event({
      sessionId: input.parentSession.id,
      turnId: input.parentTurnId,
      name: "approval.requested",
      source: "server",
      action: "subagent_patch_apply",
      appId: input.parentSession.appId,
      status: "pending",
      output: approval.title,
      data: approval,
    }));
    return approval;
  }

  return {
    requestSubagentPatchApplyApproval,
    resolveSubagentPatchApplyApproval,
  };
}

function approvalStatusForDecision(decision: ResolveApprovalRequest["decision"]): Approval["status"] {
  if (decision === "accept" || decision === "acceptForSession") return "accepted";
  return decision === "cancel" ? "cancelled" : "declined";
}

async function applySubagentPatchApproval(input: {
  approval: Approval;
  run: SubagentRun;
}): Promise<Record<string, unknown>> {
  const handoff = workspaceHandoffFromRun(input.run);
  if (!handoff || !truthyRecordBoolean(handoff, "changed")) {
    throw new Error("Subagent run has no captured patch to apply.");
  }
  const patchPath = stringFromRecord(handoff, "patchPath");
  const parentRepoPath = stringFromRecord(handoff, "parentRepoPath");
  const workspaceRoot = stringFromRecord(handoff, "workspaceRoot");
  const patchRootPath = stringFromRecord(handoff, "patchRootPath") ?? workspaceRoot;
  if (!patchPath || !parentRepoPath || !workspaceRoot || !patchRootPath) {
    throw new Error("Subagent patch handoff is missing patchPath, parentRepoPath, or workspaceRoot.");
  }
  assertPathInside({ rootPath: patchRootPath, targetPath: patchPath, label: "Subagent patch" });
  const checkResult = await runWorkspaceCommand("git", ["apply", "--check", patchPath], parentRepoPath);
  if (checkResult.code !== 0) {
    throw new Error(checkResult.stderr.trim() || checkResult.stdout.trim() || "Subagent patch does not apply cleanly to the parent workspace.");
  }
  const applyResult = await runWorkspaceCommand("git", ["apply", patchPath], parentRepoPath);
  if (applyResult.code !== 0) {
    throw new Error(applyResult.stderr.trim() || applyResult.stdout.trim() || "Subagent patch failed to apply to the parent workspace.");
  }
  return {
    status: "applied",
    approvalId: input.approval.id,
    appliedAt: now(),
    parentRepoPath,
    patchPath,
    checkStdout: checkResult.stdout.trim() || null,
    applyStdout: applyResult.stdout.trim() || null,
  };
}
