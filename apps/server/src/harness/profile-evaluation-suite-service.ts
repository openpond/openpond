import { z } from "zod";

import { ChatModelRefSchema, ReleaseHashSchema, ReleaseIdSchema, ReleaseTimestampSchema, contentHash } from "@openpond/harness";
import { createProfileEvaluationSuiteRun } from "@openpond/evals";

import type { SqliteStore } from "../store/store.js";
import type { LocalProfileEvaluationRun } from "../store/store-evaluation-results.js";
import { profileEvaluationsForRelease } from "./local-profile-evaluation-runtime.js";
import type { createProfileEvaluationRunPreparationService } from "./profile-evaluation-run-preparation.js";

const SuiteRequestSchema = z.object({
  id: ReleaseIdSchema,
  suiteId: ReleaseIdSchema,
  createdAt: ReleaseTimestampSchema,
  modelRef: ChatModelRefSchema,
  /** Supplied only by a trusted hosted adapter; Desktop resolves the local
   * provider configuration itself for every member. */
  hostModelConfigurationHash: ReleaseHashSchema.optional(),
}).strict();

type PreparedRun = Awaited<ReturnType<ReturnType<typeof createProfileEvaluationRunPreparationService>>>;

/** Run every declared definition against its own frozen Taskset and retain a
 * suite receipt only after each member's complete run has been persisted. */
export function createProfileEvaluationSuiteService(input: {
  store: SqliteStore;
  selectedWorkflows: () => Promise<{ profileRef: PreparedRun["profileRef"]; sourceRevision: string; harnessRelease: { id: string; contentHash: string } }>;
  prepareRun: (request: unknown) => Promise<PreparedRun>;
  executeRun: (request: PreparedRun) => Promise<LocalProfileEvaluationRun>;
}) {
  const inFlight = new Map<string, { requestHash: string; promise: Promise<Awaited<ReturnType<SqliteStore["saveProfileEvaluationSuiteRun"]>>> }>();
  const run = async (request: z.infer<typeof SuiteRequestSchema>) => {
    const selected = await input.selectedWorkflows();
    const discovered = await profileEvaluationsForRelease({
      store: input.store, ref: selected.profileRef,
      sourceRevision: selected.sourceRevision, harnessRelease: selected.harnessRelease,
    });
    const catalog = {
      schemaVersion: "openpond.profileEvaluations.v1" as const,
      definitions: discovered.definitions,
      suites: discovered.suites,
    };
    const suite = catalog.suites.find((candidate) => candidate.id === request.suiteId);
    if (!suite) throw new Error(`Profile evaluation suite ${request.suiteId} is absent from the selected release.`);
    const preparedRuns = [];
    for (const definitionId of suite.definitionIds) {
      preparedRuns.push(await input.prepareRun({
        id: `suite-${contentHash([request.id, definitionId]).slice(0, 32)}`,
        createdAt: request.createdAt,
        definitionId,
        modelRef: request.modelRef,
        ...(request.hostModelConfigurationHash ? { hostModelConfigurationHash: request.hostModelConfigurationHash } : {}),
      }));
    }
    const existing = await input.store.getProfileEvaluationSuiteRun(request.id);
    if (existing) {
      if (existing.suiteId !== suite.id || existing.catalogHash !== contentHash(catalog)
        || existing.profileId !== selected.profileRef.profileId
        || existing.sourceRevision !== selected.sourceRevision
        || existing.harnessRelease.id !== selected.harnessRelease.id
        || existing.harnessRelease.contentHash !== selected.harnessRelease.contentHash
        || existing.createdAt !== request.createdAt) {
        throw new Error(`Profile evaluation suite run ${request.id} already exists with another request.`);
      }
      for (const [index, member] of existing.members.entries()) {
        const run = await input.store.getProfileEvaluationRun(member.runManifest.id);
        if (!run || run.contentHash !== member.runHash || run.manifest.contentHash !== member.runManifest.contentHash
          || run.manifest.contentHash !== preparedRuns[index]?.manifest.contentHash) {
          throw new Error("Retained Profile evaluation suite is missing member evidence.");
        }
        const policy = run.manifest.policy;
        if (policy.kind !== "model" || policy.model.provider !== request.modelRef.providerId
          || policy.model.model !== request.modelRef.modelId) {
          throw new Error(`Profile evaluation suite run ${request.id} already exists with another model.`);
        }
      }
      return existing;
    }
    const members = [];
    for (const [index, definitionId] of suite.definitionIds.entries()) {
      const prepared = preparedRuns[index]!;
      const result = await input.executeRun(prepared);
      members.push({
        definitionId,
        manifest: result.manifest,
        runHash: result.contentHash,
        passed: result.passed,
        score: result.metric.value,
      });
    }
    const suiteRun = createProfileEvaluationSuiteRun({
      id: request.id, suiteId: suite.id, catalog, members,
      createdAt: request.createdAt, completedAt: new Date().toISOString(),
    });
    return input.store.saveProfileEvaluationSuiteRun(selected.profileRef, catalog, suiteRun);
  };
  return (value: unknown) => {
    const request = SuiteRequestSchema.parse(value);
    const requestHash = contentHash(request);
    const current = inFlight.get(request.id);
    if (current) {
      if (current.requestHash !== requestHash) throw new Error(`Profile evaluation suite run ${request.id} is already running with another request.`);
      return current.promise;
    }
    const promise = run(request);
    inFlight.set(request.id, { requestHash, promise });
    void promise.finally(() => {
      if (inFlight.get(request.id)?.promise === promise) inFlight.delete(request.id);
    }).catch(() => {});
    return promise;
  };
}
