import { type OpenPondProfileRef } from "@openpond/contracts";
import { contentHash } from "@openpond/harness";

import type { HarnessStateStore } from "../store/harness-state-store.js";
import { readProfileEvaluationPolicyEvidence } from "./profile-evaluation-policy-evidence.js";
import { z } from "zod";

export const ProfileEvaluationInspectionRequestSchema = z.object({
  runId: z.string().trim().min(1).max(240),
  receiptId: z.string().trim().min(1).max(500).optional(),
  eventAfterId: z.string().trim().min(1).max(500).optional(),
  eventLimit: z.number().int().min(1).max(250).optional(),
}).strict().refine(value => value.receiptId || (!value.eventAfterId && !value.eventLimit),
  "Select a case before requesting its trace page.");

/** Return only the policy-safe case summary for one retained run in this Profile. */
export async function inspectProfileEvaluationRun(input: {
  store: Pick<HarnessStateStore, "getProfileEvaluationRun" | "getProfileEvaluationReceipt" | "getProfileEvaluationGrade"
    | "getSession" | "getTurn" | "runtimeEventsForTurn" | "listModelUsageRecords">;
  profileRef: OpenPondProfileRef;
  runId: string;
  receiptId?: string;
  eventAfterId?: string;
  eventLimit?: number;
}) {
  const run = await input.store.getProfileEvaluationRun(input.runId);
  if (!run || contentHash(run.profileRef) !== contentHash(input.profileRef)) {
    throw new Error("Profile evaluation run is unavailable in the selected Profile.");
  }
  const members = run.manifest.population.map((member, index) => ({ member, index }))
    .filter(({ member }) => !input.receiptId || member.receiptId === input.receiptId);
  if (input.receiptId && members.length !== 1) throw new Error("Profile evaluation case is unavailable in the selected run.");
  const cases = await Promise.all(members.map(async ({ member, index }) => {
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
      feedback: grade.components.map((component) => ({
        graderId: component.graderId, graderVersion: component.graderVersion,
        score: component.score, passed: component.passed, feedback: component.feedback,
      })),
      ...(input.receiptId ? {
        evidence: await readProfileEvaluationPolicyEvidence({
          store: input.store, profileRef: input.profileRef, manifest: run.manifest, receipt,
          eventAfterId: input.eventAfterId, eventLimit: input.eventLimit,
        }),
      } : {}),
    };
  }));
  return { runId: run.manifest.id, sourceRevision: run.manifest.profileEvaluation?.sourceRevision ?? null, cases };
}
