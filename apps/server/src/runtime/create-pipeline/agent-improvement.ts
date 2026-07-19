import type {
  CreateImproveCandidate,
  CreateImproveRun,
  RuntimeEvent,
  SendTurnRequest,
  Session,
  GradeResult,
  TaskAttemptResult,
  Taskset,
  Turn,
} from "@openpond/contracts";
import type { RuntimeCodexSession } from "../../types.js";
import {
  resolveLocalCreatePipelineTarget,
  runLocalCreatePipelineChecks,
  runModelBackedLocalCreateSourceApplication,
  type LocalCreatePipelineCheckInput,
  type LocalCreatePipelineCheckResult,
} from "../local-create-pipeline.js";
import { runNormalizedAgentEvaluation } from "./agent-evaluation.js";
import {
  commitAgentImprovementCandidate,
  prepareAgentImprovementWorkspace,
  restoreAgentImprovementWorkspace,
} from "./agent-improvement-git.js";
import { nextCreateImproveRunRevision } from "@openpond/contracts";

type CodexTurnInput = Pick<
  SendTurnRequest,
  "approvalPolicy" | "sandbox" | "model" | "codexPermissionMode" | "codexReasoningEffort"
>;

export type AgentImprovementExecutionContext = {
  session: Session;
  turn: Turn;
  ensureCodexRuntime: (
    session: Session,
    turnInput: CodexTurnInput,
  ) => Promise<RuntimeCodexSession>;
  appendRuntimeEvent: (runtimeEvent: RuntimeEvent) => Promise<void>;
  setProviderTurnId: (providerTurnId: string) => Promise<void>;
  onRun: (run: CreateImproveRun) => Promise<void>;
  model: string | null;
  runChecks?: (input: LocalCreatePipelineCheckInput) => Promise<LocalCreatePipelineCheckResult>;
  resolveTaskset?: (tasksetId: string, revision: number, contentHash: string) => Promise<Taskset | null>;
  gradeTaskAttempt?: (input: { tasksetId: string; taskId: string; attempt: TaskAttemptResult }) => Promise<GradeResult>;
};

export async function authorAgentImprovementCandidate(
  run: CreateImproveRun,
  context: AgentImprovementExecutionContext,
  services: {
    prepareWorkspace?: typeof prepareAgentImprovementWorkspace;
    applySource?: typeof runModelBackedLocalCreateSourceApplication;
    runChecks?: typeof runLocalCreatePipelineChecks;
    commitCandidate?: typeof commitAgentImprovementCandidate;
    evaluate?: typeof runNormalizedAgentEvaluation;
  } = {},
): Promise<CreateImproveRun> {
  if (
    run.operation !== "improve" ||
    run.target.kind !== "agent" ||
    run.adapter.kind !== "local" ||
    run.state !== "applying_source" ||
    run.plan?.status !== "approved"
  ) {
    return run;
  }
  const timestamp = () => new Date().toISOString();
  let current = run;
  try {
    const activeTarget = resolveLocalCreatePipelineTarget(run);
    const taskset = run.tasksetRef
      ? await context.resolveTaskset?.(
          run.tasksetRef.id,
          run.tasksetRef.revision,
          run.tasksetRef.contentHash,
        ) ?? null
      : null;
    const authoringContext = taskset ? publicTasksetAuthoringContext(run, taskset) : null;
    const candidateId = `agent_candidate_${run.id}`;
    const authoringExecutionId = `candidate_authoring_${candidateId}`;
    const evaluationExecutionId = `evaluation_${candidateId}_${run.tasksetRef?.revision ?? "sdk"}`;
    const existingCandidate = run.candidates.find((candidate) =>
      candidate.id === candidateId
      && Boolean(candidate.git?.worktreePath)
      && ["draft", "checking"].includes(candidate.status),
    );
    const workspace = existingCandidate?.git
      ? restoreAgentImprovementWorkspace(activeTarget, existingCandidate.git)
      : await (services.prepareWorkspace ?? prepareAgentImprovementWorkspace)({
          run,
          target: activeTarget,
        });
    const candidateTarget = {
      kind: "agent" as const,
      id: activeTarget.agentId,
      displayName: run.target.displayName,
      defaultActionKey: activeTarget.defaultAction,
    };
    if (!existingCandidate) {
      current = nextCreateImproveRunRevision(run, {
        candidates: [
          ...run.candidates.filter((candidate) => candidate.id !== candidateId),
          candidateRecord({
            id: candidateId,
            run,
            target: candidateTarget,
            git: workspace.git,
            timestamp: timestamp(),
          }),
        ],
        sourceRefs: mergeRefs(run.sourceRefs, [
          `git:${workspace.git.baseCommit}`,
          workspace.git.branch,
        ]),
        externalExecutionRefs: mergeExecutionRef(run.externalExecutionRefs, {
          kind: "candidate_authoring",
          id: authoringExecutionId,
          status: "running",
          metadata: {
            candidateId,
            tasksetId: run.tasksetRef?.id ?? null,
            tasksetRevision: run.tasksetRef?.revision ?? null,
            tasksetHash: run.tasksetRef?.contentHash ?? null,
            authoringModel: run.metadata.authoringModel ?? context.model,
            allowedPaths: run.plan?.sourcePlan.map((item) => item.path) ?? [],
            startedAt: timestamp(),
          },
        }),
        metadata: {
          ...run.metadata,
          ...(authoringContext ? { tasksetAuthoringContext: authoringContext } : {}),
          agentImprovement: {
            status: "authoring",
            candidateId,
            baseBranch: workspace.git.baseBranch,
            baseCommit: workspace.git.baseCommit,
            candidateBranch: workspace.git.branch,
          },
        },
        updatedAt: timestamp(),
      });
      await context.onRun(current);

      await (services.applySource ?? runModelBackedLocalCreateSourceApplication)({
        snapshot: current,
        session: context.session,
        turn: context.turn,
        target: workspace.target,
        ensureCodexRuntime: context.ensureCodexRuntime,
        appendRuntimeEvent: context.appendRuntimeEvent,
        setProviderTurnId: context.setProviderTurnId,
        model: context.model,
      });
    }

    current = nextCreateImproveRunRevision(current, {
      state: "running_checks",
      candidates: current.candidates.map((candidate) =>
        candidate.id === candidateId
          ? { ...candidate, status: "checking" as const, updatedAt: timestamp() }
          : candidate,
      ),
      metadata: {
        ...current.metadata,
        agentImprovement: {
          ...record(current.metadata.agentImprovement),
          status: "running_checks",
        },
      },
      updatedAt: timestamp(),
    });
    await context.onRun(current);

    const checkResult = await (context.runChecks ?? services.runChecks ?? runLocalCreatePipelineChecks)({
      snapshot: current,
      target: workspace.target,
      requireEvalPass: false,
    });
    const committedGit = await (services.commitCandidate ?? commitAgentImprovementCandidate)({
      run: current,
      activeTarget,
      workspace,
    });
    current = nextCreateImproveRunRevision(current, {
      state: "evaluating",
      candidates: current.candidates.map((candidate) =>
        candidate.id === candidateId
          ? {
              ...candidate,
              status: "authored" as const,
              git: committedGit,
              sourceRefs: mergeRefs(candidate.sourceRefs, [
                `git:${committedGit.headCommit}`,
                ...committedGit.changedPaths,
              ]),
              artifactRefs: mergeRefs(candidate.artifactRefs, [
                `git-diff:${committedGit.baseCommit}..${committedGit.headCommit}`,
              ]),
              checkRefs: mergeRefs(candidate.checkRefs, checkResult.checkRefs),
              updatedAt: timestamp(),
            }
          : candidate,
      ),
      checkRefs: mergeRefs(current.checkRefs, checkResult.checkRefs),
      sourceRefs: mergeRefs(current.sourceRefs, [
        `git:${committedGit.headCommit}`,
        ...committedGit.changedPaths,
      ]),
      externalExecutionRefs: mergeExecutionRef(
        mergeExecutionRef(current.externalExecutionRefs, {
          kind: "candidate_authoring",
          id: authoringExecutionId,
          status: "completed",
          metadata: {
            candidateId,
            tasksetId: current.tasksetRef?.id ?? null,
            tasksetRevision: current.tasksetRef?.revision ?? null,
            tasksetHash: current.tasksetRef?.contentHash ?? null,
            authoringModel: current.metadata.authoringModel ?? context.model,
            candidateCommit: committedGit.headCommit,
            changedPaths: committedGit.changedPaths,
            completedAt: timestamp(),
          },
        }),
        {
          kind: "evaluation",
          id: evaluationExecutionId,
          status: "running",
          metadata: {
            candidateId,
            subjects: ["active", "candidate"],
            tasksetId: current.tasksetRef?.id ?? null,
            tasksetRevision: current.tasksetRef?.revision ?? null,
            tasksetHash: current.tasksetRef?.contentHash ?? null,
            startedAt: timestamp(),
          },
        },
      ),
      metadata: {
        ...current.metadata,
        agentImprovement: {
          ...record(current.metadata.agentImprovement),
          status: "evaluating",
          candidateCommit: committedGit.headCommit,
          changedPaths: committedGit.changedPaths,
          diffStat: committedGit.diffStat,
          checks: checkResult.metadata ?? {},
        },
      },
      updatedAt: timestamp(),
    });
    await context.onRun(current);

    const [activeReceipt, candidateReceipt] = await Promise.all([
      (services.evaluate ?? runNormalizedAgentEvaluation)({
        run: current,
        cwd: activeTarget.sourceRoot,
        sourceRef: activeTarget.sourceRootRelativePath,
        sourceCommit: committedGit.baseCommit,
        sourceBranch: committedGit.baseBranch,
        candidateId,
        subject: "active",
        taskset,
        gradeAttempt: context.gradeTaskAttempt,
      }),
      (services.evaluate ?? runNormalizedAgentEvaluation)({
        run: current,
        cwd: workspace.target.sourceRoot,
        sourceRef: workspace.target.sourceRootRelativePath,
        sourceCommit: committedGit.headCommit!,
        sourceBranch: committedGit.branch,
        candidateId,
        subject: "candidate",
        taskset,
        gradeAttempt: context.gradeTaskAttempt,
      }),
    ]);
    assertMatchedTasksetExecutions(current, activeReceipt, candidateReceipt);
    const completedAt = timestamp();
    const receiptIds = [activeReceipt.id, candidateReceipt.id];
    return nextCreateImproveRunRevision(current, {
      state: "awaiting_promotion",
      candidates: current.candidates.map((candidate) =>
        candidate.id === candidateId
          ? {
              ...candidate,
              status: "evaluated" as const,
              git: committedGit,
              evaluationReceiptRefs: mergeRefs(candidate.evaluationReceiptRefs, receiptIds),
              updatedAt: completedAt,
            }
          : candidate,
      ),
      evaluationReceipts: [
        ...current.evaluationReceipts.filter((receipt) => !receiptIds.includes(receipt.id)),
        activeReceipt,
        candidateReceipt,
      ],
      externalExecutionRefs: mergeExecutionRef(current.externalExecutionRefs, {
        kind: "evaluation",
        id: evaluationExecutionId,
        status: "completed",
        metadata: {
          candidateId,
          subjects: ["active", "candidate"],
          tasksetId: current.tasksetRef?.id ?? null,
          tasksetRevision: current.tasksetRef?.revision ?? null,
          tasksetHash: current.tasksetRef?.contentHash ?? null,
          receiptIds,
          executionContractHash: activeReceipt.metadata.executionContractHash ?? null,
          completedAt,
        },
      }),
      releaseOutcome: {
        ...current.releaseOutcome,
        status: "not_requested",
        pullRequest: null,
        updatedAt: completedAt,
      },
      blockedReason: null,
      metadata: {
        ...current.metadata,
        agentImprovement: {
          ...record(current.metadata.agentImprovement),
          status: "awaiting_promotion",
          comparison: {
            active: receiptComparison(activeReceipt),
            candidate: receiptComparison(candidateReceipt),
            candidatePassed: candidateReceipt.status === "passed" &&
              candidateReceipt.publishGate === "passed",
          },
        },
      },
      updatedAt: completedAt,
    });
  } catch (error) {
    const failedAt = timestamp();
    return nextCreateImproveRunRevision(current, {
      state: "blocked",
      blockedReason: error instanceof Error ? error.message : String(error),
      metadata: {
        ...current.metadata,
        agentImprovement: {
          ...record(current.metadata.agentImprovement),
          status: "blocked",
        },
      },
      externalExecutionRefs: current.externalExecutionRefs.map((ref) =>
        (ref.kind === "candidate_authoring" || ref.kind === "evaluation") && ref.status === "running"
          ? {
              ...ref,
              status: "failed",
              metadata: {
                ...ref.metadata,
                error: error instanceof Error ? error.message : String(error),
                failedAt,
              },
            }
          : ref),
      updatedAt: failedAt,
    });
  }
}

function mergeExecutionRef(
  refs: CreateImproveRun["externalExecutionRefs"],
  next: CreateImproveRun["externalExecutionRefs"][number],
): CreateImproveRun["externalExecutionRefs"] {
  return [
    ...refs.filter((ref) => ref.kind !== next.kind || ref.id !== next.id),
    next,
  ];
}

function publicTasksetAuthoringContext(
  run: CreateImproveRun,
  taskset: Taskset,
): Record<string, unknown> {
  const ref = run.tasksetRef;
  if (!ref) throw new Error("Agent authoring requires an approved Taskset ref.");
  const allowed = new Set(ref.authoringSplitRefs);
  const tasks = taskset.tasks.filter((task) => allowed.has(task.id));
  if (tasks.length !== allowed.size) {
    throw new Error("The approved Agent Taskset authoring split could not be resolved exactly.");
  }
  return {
    tasksetId: ref.id,
    tasksetRevision: ref.revision,
    tasksetHash: ref.contentHash,
    targetRecommendation: ref.targetRecommendation,
    policyVisibleFields: ref.policyBoundary.policyVisibleFields,
    tasks: tasks.map((task) => ({
      id: task.id,
      split: task.split,
      input: task.input,
      expectedOutput: task.expectedOutput,
      tags: task.tags,
    })),
    privateEvaluation: {
      caseCount: ref.privateSplitRefs.length,
      contentsWithheld: true,
    },
  };
}

function assertMatchedTasksetExecutions(
  run: CreateImproveRun,
  active: CreateImproveRun["evaluationReceipts"][number],
  candidate: CreateImproveRun["evaluationReceipts"][number],
): void {
  if (!run.tasksetRef) return;
  for (const receipt of [active, candidate]) {
    if (
      receipt.tasksetId !== run.tasksetRef.id
      || receipt.tasksetHash !== run.tasksetRef.contentHash
      || receipt.metadata.trustedTasksetExecution !== true
    ) {
      throw new Error("Agent comparison did not use the exact approved trusted Taskset execution.");
    }
  }
  if (
    typeof active.metadata.executionContractHash !== "string"
    || active.metadata.executionContractHash !== candidate.metadata.executionContractHash
  ) {
    throw new Error("Active and candidate Agent evaluations used different Taskset execution contracts.");
  }
}

function candidateRecord(input: {
  id: string;
  run: CreateImproveRun;
  target: Extract<CreateImproveRun["target"], { kind: "agent" }>;
  git: NonNullable<CreateImproveCandidate["git"]>;
  timestamp: string;
}): CreateImproveCandidate {
  return {
    id: input.id,
    target: input.target,
    status: "draft",
    git: input.git,
    parentCandidateId: null,
    tasksetRef: input.run.tasksetRef,
    authoringModelRef: typeof input.run.metadata.authoringModel === "string"
      ? input.run.metadata.authoringModel
      : null,
    allowedPaths: input.run.plan?.sourcePlan.map((item) => item.path) ?? [],
    sourceRefs: [`git:${input.git.baseCommit}`, input.git.branch],
    artifactRefs: [],
    checkRefs: [],
    evaluationReceiptRefs: [],
    createdAt: input.timestamp,
    updatedAt: input.timestamp,
    metadata: {
      sourceAuthority: input.run.adapter.sourceAuthority,
      authoringModel: input.run.metadata.authoringModel ?? null,
    },
  };
}

function receiptComparison(
  receipt: CreateImproveRun["evaluationReceipts"][number],
): Record<string, unknown> {
  return {
    status: receipt.status,
    publishGate: receipt.publishGate,
    summaryCounts: receipt.summaryCounts,
    sourceCommit: receipt.sourceCommit,
  };
}

function mergeRefs(existing: string[], next: Array<string | null | undefined>): string[] {
  return [...new Set([...existing, ...next.filter((value): value is string => Boolean(value))])];
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}
