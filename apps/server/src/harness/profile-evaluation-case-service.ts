import { z } from "zod";
import {readLocalProfileArtifacts} from "../evaluations/local-profile-artifacts.js";
import path from "node:path";
import {
  ChatModelRefSchema, ProfileComponentBindingSchema, ProfileWorkflowBindingSchema,
  ReleaseHashSchema, ReleaseIdSchema, contentHash,
} from "@openpond/harness";
import { CHAT_ATTACHMENT_LIMITS, ChatAttachmentSchema, OpenPondProfileRefSchema, type OpenPondProfileRef, type Session, type Turn, type ChatAttachment } from "@openpond/contracts";
import { TasksetReleaseSchema, TasksetRunManifestSchema, assertProfileEvaluationRunAdmission, policyTaskView } from "@openpond/evals";
import { decodeTasksetPackageFile } from "openpond-sdk/taskset-packages";

import {admitProfileExternalDataset,type ProfileExternalDatasetResolver} from "./profile-external-dataset-admission.js";
import type { HarnessStateStore } from "../store/harness-state-store.js";
import { type ProfileEvaluationCatalogSource } from "./local-profile-evaluation-runtime.js";
import type { ProfileEvaluationDefinition } from "@openpond/evals";
import type { TasksetPackage } from "openpond-sdk/taskset-packages";
import { createProfileWorkflowEvaluationExecutor } from "./profile-evaluation-turn-executor.js";

const ProfileEvaluationCaseRequestSchema = z.object({
  manifest: TasksetRunManifestSchema,
  taskset: TasksetReleaseSchema,
  profileRef: OpenPondProfileRefSchema,
  binding: z.union([ProfileWorkflowBindingSchema, ProfileComponentBindingSchema]),
  modelRef: ChatModelRefSchema,
  modelConfigurationHash: ReleaseHashSchema,
  taskId: ReleaseIdSchema,
  seed: z.string().trim().min(1).max(500),
}).strict();

/** Admits one case against the app-server's currently authorized Profile. The
 * caller retains the full Taskset and private graders outside model context. */
export function createProfileEvaluationCaseService(input: {
  store: Pick<HarnessStateStore, "runtimeEventsForTurn">;
  storeDir?: string;
  readManagedArtifact?: Parameters<typeof readLocalProfileArtifacts>[0]["readManaged"];
  loadTasksetPackage: (definition: ProfileEvaluationDefinition, profileId: string, harnessRelease: { id: string; contentHash: string }) => Promise<TasksetPackage>;
  loadCatalog: ProfileEvaluationCatalogSource;
  resolveExternalDataset?:ProfileExternalDatasetResolver;
  admitSession?:(session:Session,manifest:import("@openpond/evals").TasksetRunManifest,taskId:string,seed:string,attachments?:ChatAttachment[])=>Promise<void>;
  settleSession?:(id:string)=>void|Promise<void>;
  selectedProfile: () => Promise<{ ref: OpenPondProfileRef; sourceRevision: string } | null>;
  createSession: (request: unknown) => Promise<Session>;
  sendTurn: (sessionId: string, request: unknown) => Promise<Turn>;
  interruptSessionTurn?: (sessionId: string, reason?: string) => Promise<Turn>;
}) {
  return async (request: unknown, signal?: AbortSignal) => {
    const parsed = ProfileEvaluationCaseRequestSchema.parse(request);
    const selected = await input.selectedProfile();
    if (!selected || contentHash(selected.ref) !== contentHash(parsed.profileRef)
      || selected.sourceRevision !== parsed.binding.sourceRevision) {
      throw new Error("Evaluation Profile differs from the app-server's authorized selection.");
    }
    const discovered = await input.loadCatalog({
      ref: selected.ref, sourceRevision: selected.sourceRevision,
      harnessRelease: parsed.binding.harnessRelease,
    });
    const source = parsed.manifest.profileEvaluation;
    const external=await admitProfileExternalDataset({manifest:parsed.manifest,taskset:parsed.taskset,selected:{profileRef:selected.ref,sourceRevision:selected.sourceRevision,harnessRelease:parsed.binding.harnessRelease},loadCatalog:input.loadCatalog,resolveExternalDataset:input.resolveExternalDataset});
    const definition = external?.definition??discovered.definitions.find((item) => item.id === source?.definitionId);
    assertProfileEvaluationRunAdmission(parsed.manifest, parsed.taskset, external?.catalog??{
      schemaVersion: "openpond.profileEvaluations.v1",
      definitions: discovered.definitions,
      suites: discovered.suites,
    });
    if (!source || !definition || (external?contentHash(external.catalog):discovered.catalogHash) !== source.catalogHash
      || contentHash(definition) !== source.definitionHash
      || contentHash(definition.target) !== contentHash(source.target)
      || definition.tasksetRelease.id !== parsed.manifest.tasksetRelease.id
      || definition.tasksetRelease.contentHash !== parsed.manifest.tasksetRelease.contentHash
      || !definition.taskIds.includes(parsed.taskId)
      || !definition.seeds.includes(parsed.seed)
      || parsed.manifest.population.filter((item) => item.taskId === parsed.taskId && item.seed === parsed.seed).length !== 1) {
      throw new Error("Evaluation case differs from its released definition or admitted population.");
    }
    const task = parsed.taskset.tasks.find((item) => item.id === parsed.taskId)!;
    const policyTask = policyTaskView(task);
    if (policyTask.artifactRefs.length !== task.artifactRefs.length
      || policyTask.artifactRefs.length > CHAT_ATTACHMENT_LIMITS.maxAttachments) {
      throw new Error("Evaluation case has an unauthorized task attachment.");
    }
    if (policyTask.artifactRefs.length && !input.storeDir) {
      throw new Error("Evaluation case attachment storage is unavailable.");
    }
    const releasedPackage = external?.packageValue??(policyTask.artifactRefs.length || task.requiredOutputs?.length ? await input.loadTasksetPackage(
      definition, selected.ref.profileId, parsed.binding.harnessRelease,
    ) : null);
    if (releasedPackage && (releasedPackage.contentHash !== parsed.manifest.packageHash
      || releasedPackage.taskset.contentHash !== parsed.taskset.contentHash)) {
      throw new Error("Evaluation case Taskset differs from its frozen package or admitted manifest.");
    }
    const attachments = policyTask.artifactRefs.map((asset) => {
      if (asset.mediaType !== "application/pdf" || asset.sizeBytes > CHAT_ATTACHMENT_LIMITS.maxAttachmentBytes) {
        throw new Error(`Evaluation case attachment ${asset.id} is not an admitted PDF.`);
      }
      const file = releasedPackage?.files.find((entry) => entry.asset.id === asset.id);
      if (!file || contentHash(file.asset) !== contentHash(asset)) {
        throw new Error(`Evaluation case attachment ${asset.id} differs from its frozen Taskset file.`);
      }
      decodeTasksetPackageFile(file);
      return ChatAttachmentSchema.parse({
        id: asset.id, name: path.basename(asset.path), kind: "file",
        mediaType: asset.mediaType, sizeBytes: asset.sizeBytes, contentsBase64: file.base64,
      });
    });
    const execute = createProfileWorkflowEvaluationExecutor({
      manifest: parsed.manifest, profileRef: selected.ref, binding: parsed.binding,
      modelRef: parsed.modelRef, modelConfigurationHash: parsed.modelConfigurationHash,
      createSession: input.createSession, sendTurn: input.sendTurn,
      ...(input.admitSession?{admitSession:(session:Session)=>input.admitSession!(session,parsed.manifest,parsed.taskId,parsed.seed,attachments)}:{}),
      ...(input.settleSession?{settleSession:input.settleSession}:{}),
      interruptSessionTurn: input.interruptSessionTurn,
      runtimeEventsForTurn: (turnId) => input.store.runtimeEventsForTurn(turnId),
      attachments, requiredOutputs: task.requiredOutputs ?? [],
    });
    if(external)await external.authorize();
    signal?.throwIfAborted();
    const result = await execute({ task: policyTask, seed: parsed.seed, source,
      ...(signal ? { signal } : {}) });
    const artifacts = await readLocalProfileArtifacts({storeDir: input.storeDir, readManaged: input.readManagedArtifact,
      attempt: {artifactRefs: result.artifactRefs, profileNative: result.retainedEvidenceRef?.sessionId && result.retainedEvidenceRef.turnId
        ? {sessionId: result.retainedEvidenceRef.sessionId, turnId: result.retainedEvidenceRef.turnId, traceHash: result.traceHash} : null},
      events: id => input.store.runtimeEventsForTurn(id), signal,
      authorize: async () => {
        signal?.throwIfAborted();
        const current = await input.selectedProfile();
        if (!current || contentHash(current) !== contentHash(selected)) throw new Error("The current artifact Profile authority changed.");
        if (external) await external.authorize();
      }});
    // Keep the policy output hash reconstructible from its sealed trace.
    // Saved artifact bytes are a separate evaluator-owned input, never text
    // supplied by the model or a field mapped from that text.
    return {...result, evidence: {...result.evidence, artifacts, caseOwner: {...result.retainedEvidenceRef, traceHash:result.traceHash}}};
  };
}
