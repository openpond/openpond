import type {ProfilePrivateGradingFactory} from "./profile-private-grading.js";
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

import {admitProfileExternalDataset,type ProfileExternalDatasetResolver} from "./profile-external-dataset-admission.js";
import type { HarnessStateStore } from "../store/harness-state-store.js";
import type { LocalProfileEvaluationRun } from "../store/store-evaluation-results.js";
import { type ProfileEvaluationCatalogSource } from "./local-profile-evaluation-runtime.js";
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
  store: Pick<HarnessStateStore, "getProfileEvaluationRun" | "saveProfileEvaluationGrade" | "saveProfileEvaluationReceipt" | "getProfileEvaluationReceipt" | "getProfileEvaluationGrade" | "saveProfileEvaluationRun">;
  loadCatalog: ProfileEvaluationCatalogSource;
  loadTasksetPackage?:Parameters<typeof createProfileEvaluationCaseService>[0]["loadTasksetPackage"];
  privateGrading?:ProfilePrivateGradingFactory;
  resolveExternalDataset?:ProfileExternalDatasetResolver;
  selectedProfile: () => Promise<{ ref: OpenPondProfileRef; sourceRevision: string } | null>;
  executeCase: ReturnType<typeof createProfileEvaluationCaseService>;
}) {
  const inFlight = new Map<string, { manifestHash: string; promise: Promise<LocalProfileEvaluationRun> }>();
  const run = async (parsed: z.infer<typeof RunRequestSchema>, signal?: AbortSignal): Promise<LocalProfileEvaluationRun> => {
    const selected = await input.selectedProfile();
    if (!selected || contentHash(selected.ref) !== contentHash(parsed.profileRef)
      || selected.sourceRevision !== parsed.binding.sourceRevision) {
      throw new Error("Evaluation Profile differs from the app-server's authorized selection.");
    }
    const discovered = await input.loadCatalog({
      ref: selected.ref, sourceRevision: selected.sourceRevision,
      harnessRelease: parsed.binding.harnessRelease,
    });
    const external=await admitProfileExternalDataset({manifest:parsed.manifest,taskset:parsed.taskset,selected:{profileRef:selected.ref,sourceRevision:selected.sourceRevision,harnessRelease:parsed.binding.harnessRelease},loadCatalog:input.loadCatalog,resolveExternalDataset:input.resolveExternalDataset});
    const catalog = external?.catalog??{
      schemaVersion: "openpond.profileEvaluations.v1" as const,
      definitions: discovered.definitions,
      suites: discovered.suites,
    };
    assertProfileEvaluationRunAdmission(parsed.manifest, parsed.taskset, catalog);
    if (!input.privateGrading && (parsed.taskset.graders.some((grader) => grader.kind === "model_judge" || grader.kind === "custom_verifier")
      || parsed.taskset.metrics?.aggregation === "custom")) {
      throw new Error("Profile evaluation cannot run this Taskset's model judge, custom verifier, or custom metric in the current app-server runtime.");
    }
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
    const definition=catalog.definitions.find(definition=>definition.id===source.definitionId)!;
    const packageValue=input.privateGrading?(external?.packageValue??await (input.loadTasksetPackage?input.loadTasksetPackage(definition,selected.ref.profileId,source.harnessRelease):Promise.reject(new Error("The current private Taskset owner is unavailable.")))):null;
    const grading=packageValue?await input.privateGrading?.(parsed.manifest,packageValue,signal):undefined;
    await grading?.authorize();
    const existing = await input.store.getProfileEvaluationRun(parsed.manifest.id);
    if (existing) {
      if (existing.manifest.contentHash !== parsed.manifest.contentHash
        || contentHash(existing.profileRef) !== contentHash(selected.ref)) {
        throw new Error(`Profile evaluation run ${parsed.manifest.id} already exists with another manifest.`);
      }
      return existing;
    }
    if(external)await external.authorize();
    signal?.throwIfAborted();
    const result = await executeProfileEvaluationRun({
      manifest: parsed.manifest, taskset: parsed.taskset, catalog,
      ...(grading?{customVerifier:grading.customVerifier,modelJudge:grading.modelJudge,metricSource:grading.metricSource,metricExecutor:grading.metricExecutor}:{}),
      execute: ({ task, seed, signal: memberSignal }) => input.executeCase({
        ...parsed, taskId: task.id, seed,
      }, memberSignal),
      ...(signal ? { signal } : {}),
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
    await grading?.authorize();
    if(external)await external.authorize();
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
  return (request: unknown, signal?: AbortSignal): Promise<LocalProfileEvaluationRun> => {
    const parsed = RunRequestSchema.parse(request);
    const current = inFlight.get(parsed.manifest.id);
    if (current) {
      if (current.manifestHash !== parsed.manifest.contentHash) {
        throw new Error(`Profile evaluation run ${parsed.manifest.id} is already running with another manifest.`);
      }
      return current.promise;
    }
    const promise = run(parsed, signal);
    inFlight.set(parsed.manifest.id, { manifestHash: parsed.manifest.contentHash, promise });
    void promise.finally(() => {
      if (inFlight.get(parsed.manifest.id)?.promise === promise) inFlight.delete(parsed.manifest.id);
    }).catch(() => {});
    return promise;
  };
}
