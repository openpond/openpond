import { expect, test, vi } from "vitest";

import { contentHash } from "@openpond/harness";
import { createTasksetRunManifest } from "@openpond/evals";

import { createProfileEvaluationSuiteService } from "./profile-evaluation-suite-service.js";
import { profileEvaluationsForRelease } from "./local-profile-evaluation-runtime.js";

vi.mock("./local-profile-evaluation-runtime.js", () => ({ profileEvaluationsForRelease: vi.fn() }));

test("suite retry reuses retained evidence only while exact model configuration matches", async () => {
  const profileRef = { source: "openpond_git" as const, repositoryId: "repository", profileId: "profile" };
  const harnessRelease = { id: "harness", contentHash: contentHash("harness") };
  const modelRef = { providerId: "openpond" as const, modelId: "model" };
  const definition = {
    id: "profile-check", label: "Whole Profile", description: "", target: { kind: "profile" as const },
    tasksetRelease: { id: "taskset", contentHash: contentHash("taskset") },
    split: "frozen_eval" as const, taskIds: ["case"], seeds: ["1"],
    criterion: { minimumPassRate: 1, requireComplete: true },
  };
  const catalog = {
    schemaVersion: "openpond.profileEvaluations.v1" as const,
    definitions: [definition],
    suites: [{ id: "whole-profile", label: "Whole Profile", scope: "profile" as const, definitionIds: [definition.id] }],
  };
  vi.mocked(profileEvaluationsForRelease).mockResolvedValue({
    profileRef, sourceRevision: "revision-1", harnessRelease,
    catalogHash: contentHash(catalog), definitions: catalog.definitions, suites: catalog.suites,
  });
  let configurationHash = contentHash("config-1");
  const prepareRun = vi.fn(async (request: { id: string; createdAt: string }) => ({
    manifest: createTasksetRunManifest({
      schemaVersion: "openpond.tasksetRunManifest.v1", id: request.id,
      tasksetRelease: definition.tasksetRelease, packageHash: contentHash("package"),
      execution: { kind: "harness", harnessRelease },
      profileEvaluation: {
        profileId: profileRef.profileId, sourceRevision: "revision-1", harnessRelease,
        catalogHash: contentHash(catalog), definitionId: definition.id,
        definitionHash: contentHash(definition), target: definition.target,
        environmentHash: contentHash("environment"),
      },
      policy: { kind: "model", model: { provider: modelRef.providerId, model: modelRef.modelId,
        revision: null, artifactHash: null, tokenizerRevision: null, chatTemplateHash: null }, configurationHash },
      gradingRole: "evaluation",
      metricPolicy: { schemaVersion: "openpond.tasksetMetricPolicy.v1", primaryMetric: "pass_rate",
        aggregation: "pass_rate", missingReward: "exclude", customAggregator: null },
      population: [{ receiptId: "receipt", taskId: "case", seed: "1", fixtureId: null }],
      runtimeTarget: { adapterId: "profile", placement: "local", runtimeVersion: "1", capabilityReceipt: contentHash("capability") },
      limits: { maxTurns: 10, timeoutMs: 60_000, maxOutputBytes: 1024, maximumSpendUsd: null },
      createdAt: request.createdAt, metadata: {},
    }),
    taskset: {}, profileRef, binding: {}, modelRef, modelConfigurationHash: configurationHash,
  }));
  let savedSuite: Awaited<ReturnType<ReturnType<typeof createProfileEvaluationSuiteService>>> | null = null;
  let savedRun: { manifest: Awaited<ReturnType<typeof prepareRun>>["manifest"]; contentHash: string; passed: boolean; metric: { value: number } } | null = null;
  const executeRun = vi.fn(async (prepared: Awaited<ReturnType<typeof prepareRun>>) => {
    savedRun = { manifest: prepared.manifest, contentHash: contentHash(prepared.manifest), passed: true, metric: { value: 1 } };
    return savedRun;
  });
  const store = {
    getProfileEvaluationSuiteRun: vi.fn(async () => savedSuite),
    getProfileEvaluationRun: vi.fn(async () => savedRun),
    saveProfileEvaluationSuiteRun: vi.fn(async (_ref: unknown, _catalog: unknown, suite: typeof savedSuite) => {
      savedSuite = suite;
      return suite;
    }),
  };
  const runSuite = createProfileEvaluationSuiteService({
    store, selectedWorkflows: async () => ({ profileRef, sourceRevision: "revision-1", harnessRelease }),
    prepareRun, executeRun,
  } as unknown as Parameters<typeof createProfileEvaluationSuiteService>[0]);
  const request = { id: "suite-run", suiteId: "whole-profile", createdAt: "2026-09-23T00:00:00.000Z", modelRef };
  const first = await runSuite(request);
  expect((await runSuite(request)).contentHash).toBe(first.contentHash);
  expect(executeRun).toHaveBeenCalledTimes(1);
  configurationHash = contentHash("config-2");
  await expect(runSuite(request)).rejects.toThrow("missing member evidence");
  expect(executeRun).toHaveBeenCalledTimes(1);
});
