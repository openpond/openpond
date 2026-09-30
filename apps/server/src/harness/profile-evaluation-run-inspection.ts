import { type OpenPondProfileRef } from "@openpond/contracts";
import { assertContentHash, contentHash } from "@openpond/harness";
import { TasksetRunManifestSchema, verifyAttemptReceipt, type TasksetRunManifest } from "@openpond/evals";

import type { HarnessStateStore } from "../store/harness-state-store.js";
import { readProfileEvaluationPolicyEvidence } from "./profile-evaluation-policy-evidence.js";
import { z } from "zod";

export const ProfileEvaluationInspectionRequestSchema = z.object({
  runId: z.string().trim().min(1).max(240),
  receiptId: z.string().trim().min(1).max(500).optional(),
  eventAfterId: z.string().trim().min(1).max(500).optional(),
  eventLimit: z.number().int().min(1).max(250).optional(),
  manifest: TasksetRunManifestSchema.optional(),
}).strict().refine(value => value.receiptId || (!value.eventAfterId && !value.eventLimit),
  "Select a case before requesting its trace page.").refine(value => !value.manifest || value.receiptId,
  "Interrupted-run inspection requires one exact case.");

/** Return only the policy-safe case summary for one retained run in this Profile. */
export async function inspectProfileEvaluationRun(input: {
  store: Pick<HarnessStateStore, "getProfileEvaluationRun" | "getProfileEvaluationReceipt" | "getProfileEvaluationGrade"
    | "getSession" | "getTurn" | "runtimeEventsForTurn" | "listModelUsageRecords">;
  profileRef: OpenPondProfileRef;
  runId: string;
  receiptId?: string;
  eventAfterId?: string;
  eventLimit?: number;
  manifest?: TasksetRunManifest;
}) {
  const run = await input.store.getProfileEvaluationRun(input.runId);
  if (run && contentHash(run.profileRef) !== contentHash(input.profileRef)) {
    throw new Error("Profile evaluation run is unavailable in the selected Profile.");
  }
  const manifest = run?.manifest ?? input.manifest;
  if (!manifest || (!run && !input.receiptId)) throw new Error("Profile evaluation run is unavailable in the selected Profile.");
  if (!run) {
    assertContentHash(manifest, "Interrupted Profile evaluation manifest");
    if (manifest.id !== input.runId || manifest.profileEvaluation?.profileId !== input.profileRef.profileId
      || input.profileRef.source === "openpond_git" && manifest.metadata.profileRepositoryId !== input.profileRef.repositoryId)
      throw new Error("Profile evaluation run is unavailable in the selected Profile.");
  } else if (input.manifest && input.manifest.contentHash !== run.manifest.contentHash) {
    throw new Error("Profile evaluation run differs from its pinned manifest.");
  }
  const members = manifest.population.map((member, index) => ({ member, index }))
    .filter(({ member }) => !input.receiptId || member.receiptId === input.receiptId);
  if (input.receiptId && members.length !== 1) throw new Error("Profile evaluation case is unavailable in the selected run.");
  const cases = await Promise.all(members.map(async ({ member, index }) => {
    const partialReceipt = run ? null : await input.store.getProfileEvaluationReceipt(member.receiptId);
    const receiptRef = run?.receiptRefs[index] ?? (partialReceipt ? { id: partialReceipt.id, contentHash: partialReceipt.contentHash } : null);
    const gradeRef = run?.gradeRefs[index] ?? partialReceipt?.graderEvidenceRefs[0];
    if (!receiptRef || !gradeRef) throw new Error("Profile evaluation run has incomplete case evidence.");
    const [receipt, grade] = await Promise.all([
      input.store.getProfileEvaluationReceipt(receiptRef.id),
      input.store.getProfileEvaluationGrade(gradeRef.contentHash),
    ]);
    if (!receipt || (!run && !verifyAttemptReceipt(receipt)) || receipt.contentHash !== receiptRef.contentHash || receipt.id !== member.receiptId
      || receipt.taskId !== member.taskId || receipt.seed !== member.seed
      || receipt.runManifest.id !== manifest.id || receipt.runManifest.contentHash !== manifest.contentHash
      || !grade || grade.contentHash !== gradeRef.contentHash
      || !receipt.graderEvidenceRefs.some((ref) => ref.id === gradeRef.id && ref.contentHash === gradeRef.contentHash)) {
      throw new Error("Profile evaluation case evidence differs from its retained run.");
    }
    return {
      taskId: member.taskId,
      seed: member.seed,
      receiptId: receipt.id,
      receiptHash: receipt.contentHash,
      traceHash: receipt.traceHash,
      outputHash: receipt.outputHash,
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
        receipt,
        evidence: await readProfileEvaluationPolicyEvidence({
          store: input.store, profileRef: input.profileRef, manifest, receipt,
          eventAfterId: input.eventAfterId, eventLimit: input.eventLimit,
        }),
      } : {}),
    };
  }));
  return { runId: manifest.id, sourceRevision: manifest.profileEvaluation?.sourceRevision ?? null, cases };
}
