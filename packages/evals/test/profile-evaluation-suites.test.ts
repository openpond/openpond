import { expect, test } from "vitest";

import { contentHash } from "@openpond/harness";
import { createProfileEvaluationSuiteRun } from "../src/profile-evaluation-suites.js";
import type { ProfileEvaluationCatalog } from "../src/profile-evaluations.js";
import { createTasksetRunManifest } from "../src/taskset-run-contract.js";

const harnessRelease = { id: "harness-1", contentHash: contentHash("harness") };
const catalog: ProfileEvaluationCatalog = {
  schemaVersion: "openpond.profileEvaluations.v1",
  definitions: [
    { id: "profile-check", label: "End to end", description: "", target: { kind: "profile" },
      tasksetRelease: { id: "profile-cases", contentHash: contentHash("profile-cases") },
      split: "frozen_eval", taskIds: ["profile-case"], seeds: ["1"],
      criterion: { minimumPassRate: 1, requireComplete: true } },
    { id: "skill-check", label: "Skill", description: "", target: { kind: "skill", skillPath: "skills/review/SKILL.md" },
      tasksetRelease: { id: "skill-cases", contentHash: contentHash("skill-cases") },
      split: "frozen_eval", taskIds: ["skill-case"], seeds: ["1"],
      criterion: { minimumPassRate: 1, requireComplete: true } },
  ],
  suites: [{ id: "whole-profile", label: "Whole Profile", scope: "profile", definitionIds: ["profile-check", "skill-check"] }],
};

function member(definitionId: string, sourceRevision = "revision-1") {
  const definition = catalog.definitions.find((candidate) => candidate.id === definitionId)!;
  const manifest = createTasksetRunManifest({
    schemaVersion: "openpond.tasksetRunManifest.v1", id: `run-${definitionId}`,
    tasksetRelease: definition.tasksetRelease, packageHash: contentHash(definitionId),
    execution: { kind: "harness", harnessRelease },
    profileEvaluation: {
      profileId: "personal", sourceRevision, harnessRelease,
      catalogHash: contentHash(catalog), definitionId,
      definitionHash: contentHash(definition), target: definition.target,
      environmentHash: contentHash(`environment-${definitionId}`),
    },
    policy: { kind: "model", model: { provider: "test", model: "model-1", revision: null,
      artifactHash: null, tokenizerRevision: null, chatTemplateHash: null },
      configurationHash: contentHash("model-1") },
    gradingRole: "evaluation",
    metricPolicy: { schemaVersion: "openpond.tasksetMetricPolicy.v1", primaryMetric: "pass_rate",
      aggregation: "pass_rate", missingReward: "exclude", customAggregator: null },
    population: [{ receiptId: `receipt-${definitionId}`, taskId: definition.taskIds[0]!, seed: "1", fixtureId: null }],
    runtimeTarget: { adapterId: "profile-runner", placement: "local", runtimeVersion: "1",
      capabilityReceipt: contentHash("runtime") },
    limits: { maxTurns: 10, timeoutMs: 60_000, maxOutputBytes: 1024, maximumSpendUsd: null },
    createdAt: "2026-09-23T00:00:00.000Z", metadata: {},
  });
  return { definitionId, manifest, runHash: contentHash(`result-${definitionId}`),
    passed: definitionId === "profile-check", score: definitionId === "profile-check" ? 1 : 0.5 };
}

test("Profile suite preserves unlike component scores and requires every check to pass", () => {
  const members = [member("profile-check"), member("skill-check")];
  const suite = createProfileEvaluationSuiteRun({
    id: "suite-run-1", suiteId: "whole-profile", catalog, members,
    createdAt: "2026-09-23T00:00:00.000Z", completedAt: "2026-09-23T01:00:00.000Z",
  });
  expect(suite.members.map((item) => item.score)).toEqual([1, 0.5]);
  expect(suite.members.map((item) => item.runManifest.id)).toEqual(["run-profile-check", "run-skill-check"]);
  expect(suite.passed).toBe(false);
  const { contentHash: _hash, ...content } = suite;
  expect(suite.contentHash).toBe(contentHash(content));
});

test("Profile suite rejects missing checks and mixed source releases", () => {
  const first = member("profile-check");
  const second = member("skill-check", "revision-2");
  const input = { id: "suite-run-2", suiteId: "whole-profile", catalog,
    createdAt: "2026-09-23T00:00:00.000Z", completedAt: "2026-09-23T01:00:00.000Z" };
  expect(() => createProfileEvaluationSuiteRun({ ...input, members: [first] })).toThrow("incomplete run population");
  expect(() => createProfileEvaluationSuiteRun({ ...input, members: [first, second] })).toThrow("different Profile releases");
});

test("Profile suite rejects mixed model configurations", () => {
  const first = member("profile-check");
  const second = member("skill-check");
  if (second.manifest.policy.kind !== "model") throw new Error("Expected model policy.");
  const { contentHash: _hash, ...manifestContent } = second.manifest;
  const manifest = createTasksetRunManifest({
    ...manifestContent,
    policy: { ...second.manifest.policy, configurationHash: contentHash("different-model-config") },
  });
  expect(() => createProfileEvaluationSuiteRun({
    id: "suite-run-3", suiteId: "whole-profile", catalog,
    members: [first, { ...second, manifest }],
    createdAt: "2026-09-23T00:00:00.000Z", completedAt: "2026-09-23T01:00:00.000Z",
  })).toThrow("different model configurations");
});
