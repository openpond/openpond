import { z } from "zod";

import { ChatModelRefSchema, ReleaseIdSchema, ReleaseTimestampSchema, contentHash } from "@openpond/harness";
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
    const existing = await input.store.getProfileEvaluationSuiteRun(request.id);
    if (existing) {
      if (existing.suiteId !== suite.id || existing.catalogHash !== contentHash(catalog)
        || existing.createdAt !== request.createdAt) {
        throw new Error(`Profile evaluation suite run ${request.id} already exists with another request.`);
      }
      for (const member of existing.members) {
        const run = await input.store.getProfileEvaluationRun(member.runManifest.id);
        if (!run || run.contentHash !== member.runHash || run.manifest.contentHash !== member.runManifest.contentHash) {
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
    for (const definitionId of suite.definitionIds) {
      const prepared = await input.prepareRun({
        id: `suite-${contentHash([request.id, definitionId]).slice(0, 32)}`,
        createdAt: request.createdAt,
        definitionId,
        modelRef: request.modelRef,
      });
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
