import { z } from "zod";
import {
  ChatModelRefSchema, ProfileComponentBindingSchema, ProfileWorkflowBindingSchema,
  ReleaseHashSchema, ReleaseIdSchema, contentHash,
} from "@openpond/harness";
import { OpenPondProfileRefSchema, type OpenPondProfileRef, type Session, type Turn } from "@openpond/contracts";
import { TasksetReleaseSchema, TasksetRunManifestSchema, assertProfileEvaluationRunAdmission, policyTaskView } from "@openpond/evals";

import type { SqliteStore } from "../store/store.js";
import { profileEvaluationsForRelease } from "./local-profile-evaluation-runtime.js";
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
  store: SqliteStore;
  selectedProfile: () => Promise<{ ref: OpenPondProfileRef; sourceRevision: string } | null>;
  createSession: (request: unknown) => Promise<Session>;
  sendTurn: (sessionId: string, request: unknown) => Promise<Turn>;
}) {
  return async (request: unknown) => {
    const parsed = ProfileEvaluationCaseRequestSchema.parse(request);
    const selected = await input.selectedProfile();
    if (!selected || contentHash(selected.ref) !== contentHash(parsed.profileRef)
      || selected.sourceRevision !== parsed.binding.sourceRevision) {
      throw new Error("Evaluation Profile differs from the app-server's authorized selection.");
    }
    const discovered = await profileEvaluationsForRelease({
      store: input.store, ref: selected.ref, sourceRevision: selected.sourceRevision,
      harnessRelease: parsed.binding.harnessRelease,
    });
    const source = parsed.manifest.profileEvaluation;
    const definition = discovered.definitions.find((item) => item.id === source?.definitionId);
    assertProfileEvaluationRunAdmission(parsed.manifest, parsed.taskset, {
      schemaVersion: "openpond.profileEvaluations.v1",
      definitions: discovered.definitions,
      suites: discovered.suites,
    });
    if (!source || !definition || discovered.catalogHash !== source.catalogHash
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
    const execute = createProfileWorkflowEvaluationExecutor({
      manifest: parsed.manifest, profileRef: selected.ref, binding: parsed.binding,
      modelRef: parsed.modelRef, modelConfigurationHash: parsed.modelConfigurationHash,
      createSession: input.createSession, sendTurn: input.sendTurn,
      runtimeEventsForTurn: (turnId) => input.store.runtimeEventsForTurn(turnId),
    });
    return execute({ task: policyTaskView(task), seed: parsed.seed, source });
  };
}
