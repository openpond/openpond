import {
  nextCreateImproveRunRevision,
  type CreateImproveRun,
  type CreateImproveEvaluationReceipt,
  type CreateImproveTarget,
} from "@openpond/contracts";
import {
  applyApprovedLocalCreateImproveRun,
  type LocalCreatePipelineCheckInput,
  type LocalCreatePipelineCheckResult,
} from "../local-create-pipeline.js";
import type { RuntimeCodexSession } from "../../types.js";
import type { GradeResult, RuntimeEvent, SendTurnRequest, Session, TaskAttemptResult, Taskset, Turn } from "@openpond/contracts";
import { authorAgentImprovementCandidate } from "./agent-improvement.js";

type CodexTurnInput = Pick<
  SendTurnRequest,
  "approvalPolicy" | "sandbox" | "model" | "codexPermissionMode" | "codexReasoningEffort"
>;

export type CreateImproveTargetExecutionContext = {
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

export type CreateImproveTargetAdapter = {
  kind: CreateImproveTarget["kind"];
  planningContext(run: CreateImproveRun): Record<string, unknown>;
  scaffold(run: CreateImproveRun): {
    sourcePlan: NonNullable<CreateImproveRun["plan"]>["sourcePlan"];
    requirements: NonNullable<CreateImproveRun["plan"]>["requirements"];
  };
  allowedPaths(run: CreateImproveRun): string[];
  checks(run: CreateImproveRun): NonNullable<CreateImproveRun["plan"]>["checks"];
  evalRefs(run: CreateImproveRun): string[];
  canExecute(run: CreateImproveRun): boolean;
  execute(
    run: CreateImproveRun,
    context: CreateImproveTargetExecutionContext,
  ): Promise<CreateImproveRun>;
  normalizeResult(run: CreateImproveRun): CreateImproveRun;
};

const agentTargetAdapter: CreateImproveTargetAdapter = {
  kind: "agent",
  planningContext: commonPlanningContext,
  scaffold: commonScaffold,
  allowedPaths: plannedPaths,
  checks: plannedChecks,
  evalRefs: (run) => run.context.evalRefs,
  canExecute: (run) =>
    run.target.kind === "agent" &&
    run.adapter.kind === "local" &&
    run.state === "applying_source" &&
    run.plan?.status === "approved",
  execute: (run, context) =>
    run.operation === "improve"
      ? authorAgentImprovementCandidate(run, context)
      : applyApprovedLocalCreateImproveRun(run, {
          session: context.session,
          turn: context.turn,
          ensureCodexRuntime: context.ensureCodexRuntime,
          appendRuntimeEvent: context.appendRuntimeEvent,
          setProviderTurnId: context.setProviderTurnId,
          onSnapshot: context.onRun,
          model: context.model,
          runChecks: context.runChecks,
        }),
  normalizeResult: (run) => run,
};

const unsupportedSourceTargetAdapter = (
  kind: Exclude<CreateImproveTarget["kind"], "agent" | "model">,
): CreateImproveTargetAdapter => ({
  kind,
  planningContext: commonPlanningContext,
  scaffold: commonScaffold,
  allowedPaths: plannedPaths,
  checks: plannedChecks,
  evalRefs: (run) => run.context.evalRefs,
  canExecute: () => false,
  execute: async (run) =>
    nextCreateImproveRunRevision(run, {
      state: "blocked",
      blockedReason: `${kind} authoring is not registered in this OpenPond build.`,
      updatedAt: new Date().toISOString(),
    }),
  normalizeResult: (run) => run,
});

const modelTargetAdapter: CreateImproveTargetAdapter = {
  kind: "model",
  planningContext: (run) => ({
    ...commonPlanningContext(run),
    specializedEvaluator: "taskset",
  }),
  scaffold: commonScaffold,
  allowedPaths: () => [],
  checks: plannedChecks,
  evalRefs: (run) => [
    ...run.context.evalRefs,
    ...run.evaluationReceipts.flatMap((receipt) => receipt.evalRefs),
  ],
  canExecute: () => false,
  execute: async (run) => run,
  normalizeResult: (run) => run,
};

const TARGET_ADAPTERS = new Map<CreateImproveTarget["kind"], CreateImproveTargetAdapter>([
  ["agent", agentTargetAdapter],
  ["skill", unsupportedSourceTargetAdapter("skill")],
  ["extension", unsupportedSourceTargetAdapter("extension")],
  ["model", modelTargetAdapter],
  ["configuration", unsupportedSourceTargetAdapter("configuration")],
  ["unselected", unsupportedSourceTargetAdapter("unselected")],
]);

export function createImproveTargetAdapter(
  target: CreateImproveTarget,
): CreateImproveTargetAdapter {
  const adapter = TARGET_ADAPTERS.get(target.kind);
  if (!adapter) throw new Error(`No Create/Improve target adapter is registered for ${target.kind}.`);
  return adapter;
}

export function attachModelTargetRefs(input: {
  run: CreateImproveRun;
  tasksetId?: string | null;
  trainingPlanId?: string | null;
  trainingJobId?: string | null;
  artifactId?: string | null;
  evaluations?: Array<{
    subject: "active" | "candidate";
    attemptRefs: string[];
    gradeRefs: string[];
    total: number;
    passed: number;
    failed: number;
    infrastructureFailureCount?: number;
    evaluationComplete?: boolean;
    executionContractHash: string;
  }> | null;
  completed?: boolean;
  timestamp?: string;
}): CreateImproveRun {
  if (input.run.target.kind !== "model") {
    throw new Error("Model refs can only be attached to a Model Create/Improve run.");
  }
  const currentTarget = input.run.target;
  const timestamp = input.timestamp ?? new Date().toISOString();
  if (
    input.run.tasksetRef &&
    input.tasksetId &&
    input.tasksetId !== input.run.tasksetRef.id
  ) {
    throw new Error(
      `Model execution cannot replace approved Taskset ${input.run.tasksetRef.id} with ${input.tasksetId}.`,
    );
  }
  const target = {
    ...input.run.target,
    trainingPlanId: input.trainingPlanId ?? currentTarget.trainingPlanId,
    trainingJobId: input.trainingJobId ?? currentTarget.trainingJobId,
    artifactId:
      input.artifactId !== undefined
        ? input.artifactId
        : input.trainingJobId &&
            input.trainingJobId !== currentTarget.trainingJobId
          ? null
          : currentTarget.artifactId,
  };
  const evaluationReceipts = (input.evaluations ?? []).map((evaluation) => ({
    id: `model_eval_${input.run.id}_${input.trainingJobId ?? currentTarget.trainingJobId ?? input.run.revision + 1}_${evaluation.subject}`,
    evaluation,
  }));
  const candidateEvaluationReceiptIds = evaluationReceipts
    .filter(({ evaluation }) => evaluation.subject === "candidate")
    .map(({ id }) => id);
  const modelCandidates = input.run.candidates.filter(
    (candidate) => candidate.target.kind === "model",
  );
  const existingModelCandidate =
    modelCandidates.find(
      (candidate) =>
        candidate.target.kind === "model" &&
        candidate.target.trainingJobId === target.trainingJobId,
    ) ??
    modelCandidates.find(
      (candidate) =>
        candidate.target.kind === "model" &&
        !candidate.target.trainingJobId &&
        !candidate.target.artifactId,
    );
  const priorModelCandidate = modelCandidates.at(-1) ?? null;
  const modelCandidateId =
    existingModelCandidate?.id ??
    (
      modelCandidates.length && target.trainingJobId
        ? `model_candidate_${input.run.id}_${target.trainingJobId}`
        : `model_candidate_${input.run.id}`
    );
  const updateModelCandidate = (
    candidate: CreateImproveRun["candidates"][number],
  ): CreateImproveRun["candidates"][number] => ({
    ...candidate,
    target,
    status: evaluationReceipts.length ? "evaluated" : candidate.status,
    tasksetRef: candidate.tasksetRef ?? input.run.tasksetRef,
    sourceRefs: input.run.tasksetRef
      ? [...new Set([...candidate.sourceRefs, input.run.tasksetRef.id])]
      : candidate.sourceRefs,
    artifactRefs: target.artifactId
      ? [...new Set([...candidate.artifactRefs, target.artifactId])]
      : candidate.artifactRefs,
    evaluationReceiptRefs: candidateEvaluationReceiptIds.length
      ? [...new Set([...candidate.evaluationReceiptRefs, ...candidateEvaluationReceiptIds])]
      : candidate.evaluationReceiptRefs,
    updatedAt: timestamp,
    metadata: {
      ...candidate.metadata,
      trainingPlanId: target.trainingPlanId,
      trainingJobId: target.trainingJobId,
    },
  });
  const candidates = existingModelCandidate
    ? input.run.candidates.map((candidate) =>
        candidate.id === existingModelCandidate.id
          ? updateModelCandidate(candidate)
          : candidate)
    : [
        ...input.run.candidates,
        updateModelCandidate({
          id: modelCandidateId,
          target,
          status: target.artifactId ? "authored" : "checking",
          git: null,
          parentCandidateId: priorModelCandidate?.id ?? null,
          tasksetRef: input.run.tasksetRef,
          authoringModelRef: null,
          allowedPaths: [],
          sourceRefs: [],
          artifactRefs: [],
          checkRefs: [],
          evaluationReceiptRefs: [],
          createdAt: timestamp,
          updatedAt: timestamp,
          metadata: {
            source: "model_training",
          },
        }),
      ];
  return nextCreateImproveRunRevision(input.run, {
    target,
    state: input.completed ? "ready" : "evaluating",
    blockedReason: null,
    externalExecutionRefs: mergeExternalModelRefs(input.run, target),
    candidates,
    evaluationReceipts: evaluationReceipts.length
      ? [
          ...input.run.evaluationReceipts.filter((receipt) => !evaluationReceipts.some(({ id }) => id === receipt.id)),
          ...evaluationReceipts.map(({ id, evaluation }): CreateImproveEvaluationReceipt => ({
            id,
            candidateId: evaluation.subject === "candidate" ? modelCandidateId : null,
            target,
            evaluatorKind: "taskset",
            subject: evaluation.subject,
            sourceCommit: null,
            sourceBranch: null,
            tasksetId: input.run.tasksetRef?.id ?? null,
            tasksetHash: input.run.tasksetRef?.contentHash ?? null,
            taskAttemptRefs: evaluation.attemptRefs,
            status: evaluation.evaluationComplete === false
              ? "blocked" as const
              : evaluation.failed === 0 && evaluation.total > 0
                ? "passed" as const
                : "failed" as const,
            publishGate:
              evaluation.evaluationComplete !== false &&
              evaluation.failed === 0 &&
              evaluation.total > 0
                ? "passed" as const
                : "failed" as const,
            summaryCounts: {
              total: evaluation.total,
              passed: evaluation.passed,
              failed: evaluation.failed,
            },
            evalRefs: evaluation.gradeRefs,
            artifactRefs: target.artifactId ? [target.artifactId] : [],
            summary: evaluation.evaluationComplete === false
              ? `${evaluation.subject === "active" ? "Base" : "Trained"} frozen Taskset evaluation was blocked by ${evaluation.infrastructureFailureCount ?? 0} infrastructure failure${evaluation.infrastructureFailureCount === 1 ? "" : "s"}; no quality result was recorded.`
              : `${evaluation.subject === "active" ? "Base" : "Trained"} frozen Taskset evaluation: ${evaluation.passed}/${evaluation.total} passed.`,
            createdAt: timestamp,
            metadata: {
              trustedTasksetExecution: true,
              tasksetRevision: input.run.tasksetRef?.revision ?? null,
              gradeRefs: evaluation.gradeRefs,
              executionContractHash: evaluation.executionContractHash,
              evaluationComplete: evaluation.evaluationComplete ?? true,
              infrastructureFailureCount:
                evaluation.infrastructureFailureCount ?? 0,
            },
          })),
        ]
      : input.run.evaluationReceipts,
    updatedAt: timestamp,
  });
}

function commonPlanningContext(run: CreateImproveRun): Record<string, unknown> {
  return {
    operation: run.operation,
    objective: run.objective,
    target: run.target,
    sourceAuthority: run.adapter.sourceAuthority,
    context: run.context,
  };
}

function commonScaffold(run: CreateImproveRun) {
  return {
    sourcePlan: run.plan?.sourcePlan ?? [],
    requirements: run.plan?.requirements ?? [],
  };
}

function plannedPaths(run: CreateImproveRun): string[] {
  return run.plan?.sourcePlan.map((item) => item.path) ?? [];
}

function plannedChecks(run: CreateImproveRun) {
  return run.plan?.checks ?? [];
}

function mergeExternalModelRefs(
  run: CreateImproveRun,
  target: Extract<CreateImproveTarget, { kind: "model" }>,
) {
  const byKey = new Map(
    run.externalExecutionRefs.map((ref) => [`${ref.kind}:${ref.id}`, ref] as const),
  );
  if (target.trainingJobId) {
    byKey.set(`training_job:${target.trainingJobId}`, {
      kind: "training_job",
      id: target.trainingJobId,
      status: target.artifactId ? "completed" : "running",
      metadata: {
        tasksetId: run.tasksetRef?.id ?? null,
        tasksetHash: run.tasksetRef?.contentHash ?? null,
        trainingPlanId: target.trainingPlanId,
        artifactId: target.artifactId,
      },
    });
  }
  return [...byKey.values()];
}
