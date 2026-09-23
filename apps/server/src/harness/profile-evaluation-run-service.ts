import { z } from "zod";
import {
  ChatModelRefSchema, ProfileComponentBindingSchema, ProfileWorkflowBindingSchema, ReleaseHashSchema,
  contentHash,
} from "@openpond/harness";
import { OpenPondProfileRefSchema, type OpenPondProfileRef } from "@openpond/contracts";
import {
  TasksetReleaseSchema, TasksetRunManifestSchema, assertProfileEvaluationRunAdmission,
  executeProfileEvaluationRun,
} from "@openpond/evals";

import type { SqliteStore } from "../store/store.js";
import type { LocalProfileEvaluationRun } from "../store/store-evaluation-results.js";
import { profileEvaluationsForRelease } from "./local-profile-evaluation-runtime.js";
import { createProfileEvaluationCaseService } from "./profile-evaluation-case-service.js";

const RunRequestSchema = z.object({
  manifest: TasksetRunManifestSchema,
  taskset: TasksetReleaseSchema,
  profileRef: OpenPondProfileRefSchema,
  binding: z.union([ProfileWorkflowBindingSchema, ProfileComponentBindingSchema]),
  modelRef: ChatModelRefSchema,
  modelConfigurationHash: ReleaseHashSchema,
}).strict();

export function createProfileEvaluationRunService(input: {
  store: SqliteStore;
  selectedProfile: () => Promise<{ ref: OpenPondProfileRef; sourceRevision: string } | null>;
  executeCase: ReturnType<typeof createProfileEvaluationCaseService>;
}) {
  const inFlight = new Map<string, { manifestHash: string; promise: Promise<LocalProfileEvaluationRun> }>();
  const run = async (parsed: z.infer<typeof RunRequestSchema>): Promise<LocalProfileEvaluationRun> => {
    const selected = await input.selectedProfile();
    if (!selected || contentHash(selected.ref) !== contentHash(parsed.profileRef)
      || selected.sourceRevision !== parsed.binding.sourceRevision) {
      throw new Error("Evaluation Profile differs from the app-server's authorized selection.");
    }
    const discovered = await profileEvaluationsForRelease({
      store: input.store, ref: selected.ref, sourceRevision: selected.sourceRevision,
      harnessRelease: parsed.binding.harnessRelease,
    });
    const catalog = {
      schemaVersion: "openpond.profileEvaluations.v1" as const,
      definitions: discovered.definitions,
      suites: discovered.suites,
    };
    assertProfileEvaluationRunAdmission(parsed.manifest, parsed.taskset, catalog);
    const source = parsed.manifest.profileEvaluation!;
    const policy = parsed.manifest.policy;
    if (source.profileId !== selected.ref.profileId
      || source.sourceRevision !== parsed.binding.sourceRevision
      || source.harnessRelease.id !== parsed.binding.harnessRelease.id
      || source.harnessRelease.contentHash !== parsed.binding.harnessRelease.contentHash
      || (parsed.binding.schemaVersion === "openpond.profileWorkflowBinding.v1"
        ? source.target.kind !== "workflow" || source.target.workflowId !== parsed.binding.workflowId
        : source.target.kind === "workflow" || contentHash(source.target) !== contentHash(parsed.binding.target))
      || policy.kind !== "model"
      || policy.model.provider !== parsed.modelRef.providerId
      || policy.model.model !== parsed.modelRef.modelId
      || policy.configurationHash !== parsed.modelConfigurationHash) {
      throw new Error("Evaluation request differs from its admitted Profile workflow or model configuration.");
    }
    const existing = await input.store.getProfileEvaluationRun(parsed.manifest.id);
    if (existing) {
      if (existing.manifest.contentHash !== parsed.manifest.contentHash
        || contentHash(existing.profileRef) !== contentHash(selected.ref)) {
        throw new Error(`Profile evaluation run ${parsed.manifest.id} already exists with another manifest.`);
      }
      return existing;
    }
    const result = await executeProfileEvaluationRun({
      manifest: parsed.manifest, taskset: parsed.taskset, catalog,
      execute: ({ task, seed }) => input.executeCase({
        ...parsed, taskId: task.id, seed,
      }),
      saveGrade: async (grade) => {
        await input.store.saveProfileEvaluationGrade(grade);
        return { id: grade.contentHash, contentHash: grade.contentHash, mediaType: "application/json", sizeBytes: null };
      },
      saveReceipt: async (receipt) => { await input.store.saveProfileEvaluationReceipt(receipt); },
      loadCompletedMember: async ({ receiptId }) => {
        const receipt = await input.store.getProfileEvaluationReceipt(receiptId);
        if (!receipt) return null;
        const gradeRef = receipt.graderEvidenceRefs[0];
        const grade = gradeRef && await input.store.getProfileEvaluationGrade(gradeRef.contentHash);
        if (!grade) throw new Error(`Retained Profile evaluation receipt ${receiptId} is missing its grade.`);
        return { receipt, grade };
      },
    });
    const content = {
      profileRef: selected.ref,
      manifest: parsed.manifest, metric: result.metric,
      gradeRefs: result.grades.map((grade) => ({ id: grade.contentHash, contentHash: grade.contentHash })),
      receiptRefs: result.receipts.map((receipt) => ({ id: receipt.id, contentHash: receipt.contentHash })),
      passRate: result.passRate, passed: result.passed,
      completedAt: new Date().toISOString(),
    };
    return input.store.saveProfileEvaluationRun({ ...content, contentHash: contentHash(content) });
  };
  return (request: unknown): Promise<LocalProfileEvaluationRun> => {
    const parsed = RunRequestSchema.parse(request);
    const current = inFlight.get(parsed.manifest.id);
    if (current) {
      if (current.manifestHash !== parsed.manifest.contentHash) {
        throw new Error(`Profile evaluation run ${parsed.manifest.id} is already running with another manifest.`);
      }
      return current.promise;
    }
    const promise = run(parsed);
    inFlight.set(parsed.manifest.id, { manifestHash: parsed.manifest.contentHash, promise });
    void promise.finally(() => {
      if (inFlight.get(parsed.manifest.id)?.promise === promise) inFlight.delete(parsed.manifest.id);
    }).catch(() => {});
    return promise;
  };
}
