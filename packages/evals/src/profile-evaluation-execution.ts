import { ImmutableArtifactRefSchema, contentHash, type ImmutableArtifactRef } from "@openpond/harness";

import { gradeTaskEvidence, type AttemptEvidence, type CustomVerifierRunner, type ModelJudgeRunner, type TaskGrade } from "./graders.js";
import { aggregateTasksetRunReceipts, assertTasksetMetricSource, type TasksetMetricExecutor, type TasksetMetricResult } from "./metrics.js";
import { createAttemptReceipt, type AttemptReceipt } from "./runs.js";
import { assertProfileEvaluationRunAdmission, type TasksetRunManifest } from "./taskset-run-contract.js";
import { policyTaskView, type TasksetRelease } from "./tasksets.js";
import type { ProfileEvaluationCatalog, ProfileEvaluationRunSource } from "./profile-evaluations.js";

type PolicyTask = ReturnType<typeof policyTaskView>;

/** The installation owns execution, tools, approvals and storage. This runner
 * owns frozen population dispatch and private grading for both Desktop and web. */
export async function executeProfileEvaluationRun(input: {
  manifest: TasksetRunManifest;
  taskset: TasksetRelease;
  catalog: ProfileEvaluationCatalog;
  execute: (member: {
    task: PolicyTask;
    seed: string;
    source: ProfileEvaluationRunSource;
    signal?: AbortSignal;
  }) => Promise<{
    evidence: AttemptEvidence;
    traceHash: string;
    artifactRefs: ImmutableArtifactRef[];
    startedAt: string;
    completedAt: string;
    latencyMs: number;
    costUsd: number | null;
    terminal: boolean;
    failureClass?: AttemptReceipt["failureClass"];
  }>;
  saveGrade: (grade: TaskGrade) => Promise<ImmutableArtifactRef>;
  saveReceipt: (receipt: AttemptReceipt) => Promise<void>;
  modelJudge?: ModelJudgeRunner;
  customVerifier?: CustomVerifierRunner;
  metricSource?: string;
  metricExecutor?: TasksetMetricExecutor;
  signal?: AbortSignal;
}): Promise<{
  receipts: AttemptReceipt[];
  grades: TaskGrade[];
  metric: TasksetMetricResult;
  passRate: number;
  passed: boolean;
}> {
  assertProfileEvaluationRunAdmission(input.manifest, input.taskset, input.catalog);
  assertTasksetMetricSource(input.taskset, input.metricSource);
  const source = input.manifest.profileEvaluation!;
  const definition = input.catalog.definitions.find((item) => item.id === source.definitionId)!;
  const tasks = new Map(input.taskset.tasks.map((task) => [task.id, task]));
  const receipts: AttemptReceipt[] = [];
  const grades: TaskGrade[] = [];
  for (const member of input.manifest.population) {
    input.signal?.throwIfAborted();
    const task = tasks.get(member.taskId)!;
    const execution = await input.execute({
      task: policyTaskView(task), seed: member.seed, source,
      ...(input.signal ? { signal: input.signal } : {}),
    });
    input.signal?.throwIfAborted();
    const grade = await gradeTaskEvidence({
      task, evidence: execution.evidence, graders: input.taskset.graders,
      ...(input.modelJudge ? { modelJudge: input.modelJudge } : {}),
      ...(input.customVerifier ? { customVerifier: input.customVerifier } : {}),
      ...(input.signal ? { signal: input.signal } : {}),
    });
    const gradeRef = ImmutableArtifactRefSchema.parse(await input.saveGrade(grade));
    if (gradeRef.contentHash !== grade.contentHash) throw new Error("Stored Profile evaluation grade differs from its graded evidence.");
    const failureClass = execution.failureClass ?? grade.failureClass;
    const receipt = createAttemptReceipt({
      schemaVersion: "openpond.attemptReceipt.v1",
      id: member.receiptId,
      runManifest: { id: input.manifest.id, contentHash: input.manifest.contentHash },
      taskId: member.taskId,
      seed: member.seed,
      terminal: execution.terminal,
      failureClass,
      outputHash: execution.evidence.infrastructureError ? null : contentHash(execution.evidence.output),
      traceHash: execution.traceHash,
      artifactRefs: execution.artifactRefs,
      graderEvidenceRefs: [gradeRef],
      startedAt: execution.startedAt,
      completedAt: execution.completedAt,
      latencyMs: execution.latencyMs,
      costUsd: execution.costUsd,
      metadata: {
        gradingRole: "evaluation",
        score: grade.score,
        passed: grade.passed,
        rewardEligible: grade.rewardEligible,
        sourceRevision: source.sourceRevision,
        definitionHash: source.definitionHash,
        environmentHash: source.environmentHash,
      },
    });
    await input.saveReceipt(receipt);
    grades.push(grade);
    receipts.push(receipt);
  }
  const metric = await aggregateTasksetRunReceipts({
    manifest: input.manifest, taskset: input.taskset, receipts,
    ...(input.metricSource !== undefined ? { source: input.metricSource } : {}),
    ...(input.signal ? { signal: input.signal } : {}),
  }, input.metricExecutor);
  const passRate = grades.filter((grade) => grade.passed).length / grades.length;
  return {
    receipts, grades, metric, passRate,
    passed: passRate >= definition.criterion.minimumPassRate
      && (!definition.criterion.requireComplete || receipts.every((receipt) => receipt.terminal)),
  };
}
