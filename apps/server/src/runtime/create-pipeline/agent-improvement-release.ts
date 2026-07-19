import {
  nextCreateImproveRunRevision,
  type CreateImproveCandidate,
  type CreateImproveEvaluationReceipt,
  type CreateImproveRun,
  type CreateImproveRunAction,
  type GradeResult,
  type TaskAttemptResult,
  type Taskset,
} from "@openpond/contracts";

import { resolveLocalCreatePipelineTarget } from "../local-create-pipeline.js";
import { runNormalizedAgentEvaluation } from "./agent-evaluation.js";
import { createOutcomeEvidenceSnapshot } from "../../training/create-improve-taskset-lineage.js";
import {
  applyAgentImprovementCandidateLocally,
  cleanupAgentImprovementWorkspace,
  closeAgentImprovementPullRequest,
  inspectAgentImprovementPullRequest,
  openAgentImprovementPullRequest,
  syncMergedAgentImprovement,
  type AgentImprovementCommandRunner,
} from "./agent-improvement-git.js";

type AgentReleaseAction = Extract<
  CreateImproveRunAction,
  { type: "apply_candidate" | "open_pull_request" | "reject_candidate" | "reconcile_pull_request" }
>;

export function isAgentImprovementReleaseAction(
  action: CreateImproveRunAction,
): action is AgentReleaseAction {
  return action.type === "apply_candidate" ||
    action.type === "open_pull_request" ||
    action.type === "reject_candidate" ||
    action.type === "reconcile_pull_request";
}

export async function executeAgentImprovementReleaseAction(input: {
  run: CreateImproveRun;
  action: AgentReleaseAction;
  command?: AgentImprovementCommandRunner;
  evaluate?: typeof runNormalizedAgentEvaluation;
  resolveTaskset?: (tasksetId: string, revision: number, contentHash: string) => Promise<Taskset | null>;
  gradeTaskAttempt?: (input: { tasksetId: string; taskId: string; attempt: TaskAttemptResult }) => Promise<GradeResult>;
}): Promise<CreateImproveRun> {
  const timestamp = () => new Date().toISOString();
  const candidate = requireCandidate(input.run, input.action.candidateId);
  if (!candidate.git) throw new Error("Agent candidate has no Git lineage.");
  const activeTarget = resolveLocalCreatePipelineTarget(input.run);
  let current = input.run;
  try {
    if (input.action.type === "apply_candidate") {
      const profileCommit = current.localProfileCommit
        ? await verifyAppliedProfileCommit({
            repoPath: activeTarget.repoPath,
            expectedCommit: current.localProfileCommit,
            command: input.command,
          })
        : await applyAgentImprovementCandidateLocally({
            run: current,
            repoPath: activeTarget.repoPath,
            git: candidate.git,
            command: input.command,
          });
      let receipt: CreateImproveEvaluationReceipt;
      try {
        const taskset = current.tasksetRef
          ? await input.resolveTaskset?.(
              current.tasksetRef.id,
              current.tasksetRef.revision,
              current.tasksetRef.contentHash,
            ) ?? null
          : null;
        receipt = await (input.evaluate ?? runNormalizedAgentEvaluation)({
          run: current,
          cwd: activeTarget.sourceRoot,
          sourceRef: activeTarget.sourceRootRelativePath,
          sourceCommit: profileCommit,
          sourceBranch: candidate.git.baseBranch,
          candidateId: candidate.id,
          subject: "post_release",
          taskset,
          gradeAttempt: input.gradeTaskAttempt,
        });
      } catch (evaluationError) {
        const blockedAt = timestamp();
        const message = evaluationError instanceof Error
          ? evaluationError.message
          : String(evaluationError);
        return nextCreateImproveRunRevision(current, {
          state: "blocked",
          localProfileCommit: profileCommit,
          releaseOutcome: {
            ...current.releaseOutcome,
            status: "pending",
            profileCommit,
            pullRequest: null,
            updatedAt: blockedAt,
          },
          externalExecutionRefs: mergeExternalRef(current, {
            kind: "release",
            id: profileCommit,
            status: "verification_error",
            metadata: { candidateId: candidate.id },
          }),
          blockedReason: `The change was applied locally, but its post-merge Evals could not run: ${message}`,
          metadata: {
            ...current.metadata,
            agentImprovement: {
              ...record(current.metadata.agentImprovement),
              status: "local_verification_error",
              profileCommit,
              verificationError: message,
            },
          },
          updatedAt: blockedAt,
        });
      }
      const releasedAt = timestamp();
      const released = receipt.status === "passed" && receipt.publishGate === "passed";
      const outcomeEvidence = released
        ? createOutcomeEvidenceSnapshot({
            run: current,
            candidateId: candidate.id,
            outcome: "released",
            reason: "The promoted Agent passed trusted post-release Taskset evaluation.",
            receiptRefs: [receipt.id],
            timestamp: releasedAt,
          })
        : null;
      if (released) {
        await cleanupAgentImprovementWorkspace({
          repoPath: activeTarget.repoPath,
          git: candidate.git,
          command: input.command,
        }).catch(() => undefined);
      }
      return nextCreateImproveRunRevision(current, {
        state: released ? "released" : "blocked",
        candidates: updateCandidate(current, candidate.id, {
          status: released ? "accepted" : "evaluated",
          git: {
            ...candidate.git,
            worktreePath: released ? null : candidate.git.worktreePath,
          },
          evaluationReceiptRefs: unique([
            ...candidate.evaluationReceiptRefs,
            receipt.id,
          ]),
          updatedAt: releasedAt,
        }),
        evaluationReceipts: [
          ...current.evaluationReceipts.filter((item) => item.id !== receipt.id),
          receipt,
        ],
        evidenceSnapshots: outcomeEvidence
          ? uniqueEvidence(current, outcomeEvidence)
          : current.evidenceSnapshots,
        localProfileCommit: profileCommit,
        releaseOutcome: {
          ...current.releaseOutcome,
          status: released ? "released" : "pending",
          profileCommit,
          pullRequest: null,
          releaseReceiptRef: receipt.id,
          updatedAt: releasedAt,
        },
        externalExecutionRefs: mergeExternalRef(current, {
          kind: "release",
          id: profileCommit,
          status: released ? "released" : "verification_failed",
          metadata: {
            candidateId: candidate.id,
            verificationReceiptId: receipt.id,
          },
        }),
        blockedReason: released
          ? null
          : "The change was applied locally, but the active Agent failed its post-merge Evals.",
        metadata: {
          ...current.metadata,
          agentImprovement: {
            ...record(current.metadata.agentImprovement),
            status: released ? "released" : "local_verification_failed",
            profileCommit,
            postReleaseReceiptId: receipt.id,
          },
        },
        updatedAt: releasedAt,
      });
    }

    if (input.action.type === "open_pull_request") {
      const pullRequest = await openAgentImprovementPullRequest({
        run: current,
        git: candidate.git,
        evaluationSummary: evaluationSummary(current, candidate),
        command: input.command,
      });
      const completedAt = timestamp();
      return nextCreateImproveRunRevision(current, {
        state: "pull_request_open",
        candidates: updateCandidate(current, candidate.id, {
          git: { ...candidate.git, pullRequest },
          updatedAt: completedAt,
        }),
        releaseOutcome: {
          ...current.releaseOutcome,
          status: "pending",
          pullRequest,
          releaseReceiptRef: `github-pr:${pullRequest.number}`,
          updatedAt: completedAt,
        },
        externalExecutionRefs: mergeExternalRef(current, {
          kind: "pull_request",
          id: String(pullRequest.number),
          status: pullRequest.state,
          metadata: {
            url: pullRequest.url,
            baseBranch: pullRequest.baseBranch,
            headBranch: pullRequest.headBranch,
          },
        }),
        blockedReason: null,
        metadata: {
          ...current.metadata,
          agentImprovement: {
            ...record(current.metadata.agentImprovement),
            status: "pull_request_open",
            pullRequest,
          },
        },
        updatedAt: completedAt,
      });
    }

    if (input.action.type === "reject_candidate") {
      const reason = input.action.reason?.trim() || "Candidate rejected.";
      if (candidate.git.pullRequest) {
        await closeAgentImprovementPullRequest({
          git: candidate.git,
          reason,
          cwd: activeTarget.repoPath,
          command: input.command,
        });
      }
      await cleanupAgentImprovementWorkspace({
        repoPath: activeTarget.repoPath,
        git: candidate.git,
        command: input.command,
      }).catch(() => undefined);
      const completedAt = timestamp();
      const outcomeEvidence = createOutcomeEvidenceSnapshot({
        run: current,
        candidateId: candidate.id,
        outcome: "rejected",
        reason,
        receiptRefs: candidate.evaluationReceiptRefs,
        timestamp: completedAt,
      });
      return nextCreateImproveRunRevision(current, {
        state: "rejected",
        candidates: updateCandidate(current, candidate.id, {
          status: "rejected",
          git: candidate.git.pullRequest
            ? {
                ...candidate.git,
                pullRequest: {
                  ...candidate.git.pullRequest,
                  state: "closed",
                  updatedAt: completedAt,
                },
                worktreePath: null,
              }
            : { ...candidate.git, worktreePath: null },
          updatedAt: completedAt,
        }),
        releaseOutcome: {
          ...current.releaseOutcome,
          status: "rejected",
          pullRequest: candidate.git.pullRequest
            ? {
                ...candidate.git.pullRequest,
                state: "closed",
                updatedAt: completedAt,
              }
            : null,
          updatedAt: completedAt,
        },
        evidenceSnapshots: uniqueEvidence(current, outcomeEvidence),
        blockedReason: reason,
        metadata: {
          ...current.metadata,
          agentImprovement: {
            ...record(current.metadata.agentImprovement),
            status: "rejected",
            rejectionReason: reason,
          },
        },
        updatedAt: completedAt,
      });
    }

    const pullRequest = await inspectAgentImprovementPullRequest({
      git: candidate.git,
      cwd: activeTarget.repoPath,
      command: input.command,
    });
    if (pullRequest.state === "open") {
      const checkedAt = timestamp();
      return nextCreateImproveRunRevision(current, {
        state: "pull_request_open",
        candidates: updateCandidate(current, candidate.id, {
          git: { ...candidate.git, pullRequest },
          updatedAt: checkedAt,
        }),
        releaseOutcome: {
          ...current.releaseOutcome,
          status: "pending",
          pullRequest,
          updatedAt: checkedAt,
        },
        externalExecutionRefs: mergeExternalRef(current, {
          kind: "pull_request",
          id: String(pullRequest.number),
          status: "open",
          metadata: { url: pullRequest.url },
        }),
        blockedReason: null,
        updatedAt: checkedAt,
      });
    }
    if (pullRequest.state === "closed") {
      await cleanupAgentImprovementWorkspace({
        repoPath: activeTarget.repoPath,
        git: candidate.git,
        command: input.command,
      }).catch(() => undefined);
      const closedAt = timestamp();
      return nextCreateImproveRunRevision(current, {
        state: "rejected",
        candidates: updateCandidate(current, candidate.id, {
          status: "rejected",
          git: { ...candidate.git, pullRequest, worktreePath: null },
          updatedAt: closedAt,
        }),
        releaseOutcome: {
          ...current.releaseOutcome,
          status: "rejected",
          pullRequest,
          updatedAt: closedAt,
        },
        blockedReason: "The Agent improvement pull request was closed without merge.",
        updatedAt: closedAt,
      });
    }

    const mergedCommit = await syncMergedAgentImprovement({
      repoPath: activeTarget.repoPath,
      baseBranch: candidate.git.baseBranch,
      remoteName: candidate.git.remoteName,
      command: input.command,
    });
      const taskset = current.tasksetRef
        ? await input.resolveTaskset?.(
            current.tasksetRef.id,
            current.tasksetRef.revision,
            current.tasksetRef.contentHash,
          ) ?? null
        : null;
      const receipt = await (input.evaluate ?? runNormalizedAgentEvaluation)({
      run: current,
      cwd: activeTarget.sourceRoot,
      sourceRef: activeTarget.sourceRootRelativePath,
      sourceCommit: mergedCommit,
      sourceBranch: candidate.git.baseBranch,
      candidateId: candidate.id,
        subject: "post_release",
        taskset,
        gradeAttempt: input.gradeTaskAttempt,
    });
    const releasedAt = timestamp();
    const released = receipt.status === "passed" && receipt.publishGate === "passed";
    const outcomeEvidence = released
      ? createOutcomeEvidenceSnapshot({
          run: current,
          candidateId: candidate.id,
          outcome: "released",
          reason: "The promoted Agent passed trusted post-release Taskset evaluation.",
          receiptRefs: [receipt.id],
          timestamp: releasedAt,
        })
      : null;
    if (released) {
      await cleanupAgentImprovementWorkspace({
        repoPath: activeTarget.repoPath,
        git: candidate.git,
        command: input.command,
      }).catch(() => undefined);
    }
    return nextCreateImproveRunRevision(current, {
      state: released ? "released" : "blocked",
      candidates: updateCandidate(current, candidate.id, {
        status: released ? "accepted" : "evaluated",
        git: {
          ...candidate.git,
          pullRequest,
          worktreePath: released ? null : candidate.git.worktreePath,
        },
        evaluationReceiptRefs: unique([
          ...candidate.evaluationReceiptRefs,
          receipt.id,
        ]),
        updatedAt: releasedAt,
      }),
      evaluationReceipts: [
        ...current.evaluationReceipts.filter((item) => item.id !== receipt.id),
        receipt,
      ],
      evidenceSnapshots: outcomeEvidence
        ? uniqueEvidence(current, outcomeEvidence)
        : current.evidenceSnapshots,
      localProfileCommit: mergedCommit,
      releaseOutcome: {
        ...current.releaseOutcome,
        status: released ? "released" : "pending",
        profileCommit: mergedCommit,
        pullRequest,
        releaseReceiptRef: receipt.id,
        updatedAt: releasedAt,
      },
      externalExecutionRefs: mergeExternalRef(current, {
        kind: "pull_request",
        id: String(pullRequest.number),
        status: "merged",
        metadata: {
          url: pullRequest.url,
          mergeCommit: pullRequest.mergeCommit,
          profileCommit: mergedCommit,
          verificationReceiptId: receipt.id,
        },
      }),
      blockedReason: released
        ? null
        : "The PR merged, but the active Agent failed its post-merge publish-gate Eval.",
      metadata: {
        ...current.metadata,
        agentImprovement: {
          ...record(current.metadata.agentImprovement),
          status: released ? "released" : "merged_verification_failed",
          pullRequest,
          profileCommit: mergedCommit,
          postReleaseReceiptId: receipt.id,
        },
      },
      updatedAt: releasedAt,
    });
  } catch (error) {
    const failedAt = timestamp();
    return nextCreateImproveRunRevision(current, {
      state: current.state === "rejected" ? "rejected" : "blocked",
      blockedReason: error instanceof Error ? error.message : String(error),
      metadata: {
        ...current.metadata,
        agentImprovement: {
          ...record(current.metadata.agentImprovement),
          status: "release_action_failed",
          action: input.action.type,
        },
      },
      updatedAt: failedAt,
    });
  }
}

function uniqueEvidence(
  run: CreateImproveRun,
  evidence: CreateImproveRun["evidenceSnapshots"][number],
): CreateImproveRun["evidenceSnapshots"] {
  return [
    ...run.evidenceSnapshots.filter((snapshot) => snapshot.id !== evidence.id),
    evidence,
  ];
}

async function verifyAppliedProfileCommit(input: {
  repoPath: string;
  expectedCommit: string;
  command?: AgentImprovementCommandRunner;
}): Promise<string> {
  const command = input.command ?? (async (name, args, cwd, env) => {
    const { runWorkspaceCommand } = await import("../../workspace/workspaces.js");
    return runWorkspaceCommand(name, args, cwd, env);
  });
  const result = await command("git", ["rev-parse", "HEAD"], input.repoPath);
  const head = result.code === 0 ? result.stdout.trim() : "";
  if (!head || head !== input.expectedCommit) {
    throw new Error("The active Profile moved after the change was applied. Review the current Profile before re-running Evals.");
  }
  return head;
}

function requireCandidate(
  run: CreateImproveRun,
  candidateId: string,
): CreateImproveCandidate {
  const candidate = run.candidates.find((item) => item.id === candidateId);
  if (!candidate) throw new Error(`Create/Improve candidate not found: ${candidateId}`);
  return candidate;
}

function updateCandidate(
  run: CreateImproveRun,
  candidateId: string,
  patch: Partial<CreateImproveCandidate>,
): CreateImproveCandidate[] {
  return run.candidates.map((candidate) =>
    candidate.id === candidateId ? { ...candidate, ...patch } : candidate,
  );
}

function evaluationSummary(
  run: CreateImproveRun,
  candidate: CreateImproveCandidate,
): string {
  const receipts = run.evaluationReceipts.filter(
    (receipt) => receipt.candidateId === candidate.id &&
      (receipt.subject === "active" || receipt.subject === "candidate"),
  );
  return receipts.map((receipt) => {
    const counts = receipt.summaryCounts;
    const countText = counts ? `${counts.passed}/${counts.total} passed` : receipt.status;
    return `- **${receipt.subject === "active" ? "Base" : "Candidate"}** \`${receipt.sourceCommit?.slice(0, 12) ?? "unknown"}\`: ${countText}; publish gate ${receipt.publishGate}.`;
  }).join("\n");
}

function mergeExternalRef(
  run: CreateImproveRun,
  next: CreateImproveRun["externalExecutionRefs"][number],
): CreateImproveRun["externalExecutionRefs"] {
  return [
    ...run.externalExecutionRefs.filter(
      (item) => !(item.kind === next.kind && item.id === next.id),
    ),
    next,
  ];
}

function unique(values: string[]): string[] {
  return [...new Set(values)];
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}
