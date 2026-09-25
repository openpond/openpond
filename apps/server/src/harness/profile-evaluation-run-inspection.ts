import { type OpenPondProfileRef } from "@openpond/contracts";
import { contentHash } from "@openpond/harness";

import type { SqliteStore } from "../store/store.js";

/** Return only the policy-safe case summary for one retained run in this Profile. */
export async function inspectProfileEvaluationRun(input: {
  store: Pick<SqliteStore, "getProfileEvaluationRun" | "getProfileEvaluationReceipt" | "getProfileEvaluationGrade">;
  profileRef: OpenPondProfileRef;
  runId: string;
}) {
  const run = await input.store.getProfileEvaluationRun(input.runId);
  if (!run || contentHash(run.profileRef) !== contentHash(input.profileRef)) {
    throw new Error("Profile evaluation run is unavailable in the selected Profile.");
  }
  const cases = await Promise.all(run.manifest.population.map(async (member, index) => {
    const receiptRef = run.receiptRefs[index];
    const gradeRef = run.gradeRefs[index];
    if (!receiptRef || !gradeRef) throw new Error("Profile evaluation run has incomplete case evidence.");
    const [receipt, grade] = await Promise.all([
      input.store.getProfileEvaluationReceipt(receiptRef.id),
      input.store.getProfileEvaluationGrade(gradeRef.contentHash),
    ]);
    if (!receipt || receipt.contentHash !== receiptRef.contentHash || receipt.id !== member.receiptId
      || receipt.taskId !== member.taskId || receipt.seed !== member.seed
      || receipt.runManifest.id !== run.manifest.id || receipt.runManifest.contentHash !== run.manifest.contentHash
      || !grade || grade.contentHash !== gradeRef.contentHash
      || !receipt.graderEvidenceRefs.some((ref) => ref.id === gradeRef.id && ref.contentHash === gradeRef.contentHash)) {
      throw new Error("Profile evaluation case evidence differs from its retained run.");
    }
    return {
      taskId: member.taskId,
      seed: member.seed,
      receiptId: receipt.id,
      score: grade.score,
      passed: grade.passed,
      gradingStatus: grade.gradingStatus,
      failureClass: grade.failureClass,
      artifactCount: receipt.artifactRefs.length,
      latencyMs: receipt.latencyMs,
      costUsd: receipt.costUsd,
      terminal: receipt.terminal,
    };
  }));
  return { runId: run.manifest.id, sourceRevision: run.manifest.profileEvaluation?.sourceRevision ?? null, cases };
}
