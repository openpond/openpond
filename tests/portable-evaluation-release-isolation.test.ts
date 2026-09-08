import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import type { OpenPondProfileState, Taskset } from "@openpond/contracts";
import {
  assertComparableRunManifests,
  createVerifiedHarnessCompatibilityReceipt,
} from "@openpond/evals";
import { contentHash, sha256 } from "@openpond/harness";
import { computeTasksetHash } from "@openpond/taskset-sdk";
import { describe, expect, test } from "vitest";

import { createTaskEvaluationService } from "../apps/server/src/training/evaluation-service.js";
import { tasksetEvaluationScore } from "../apps/server/src/training/taskset-evaluation-score.js";
import {
  tasksetFixture,
  withTrainingStore,
} from "./helpers/training-fixtures.js";

describe("portable Evaluation release isolation", () => {
  // A running evaluation must use the admitted private metric even if its
  // file is edited, while a new run rejects changed bytes before inference.
  test("executes and persists the pinned authored metric independently of mean score", async () =>
    withTrainingStore(async ({ store, directory }) => {
      const reviewRef = { id: "review-metric", contentHash: contentHash("review-metric") };
      const source = "export function aggregate(scores: number[]): number { return Math.max(...scores); }";
      const changed = source.replace("Math.max", "Math.min");
      const base = tasksetFixture({ ready: true });
      const taskset: Taskset = { ...base,
        metrics: { schemaVersion: "openpond.tasksetMetricPolicy.v1", primaryMetric: "best_score", aggregation: "custom", missingReward: "exclude",
          customAggregator: { module: "metrics/aggregate.ts", exportName: "aggregate", contentHash: sha256(source), timeoutMs: 5_000, networkPolicy: "none" } },
        metadata: { ...base.metadata, harnessEvaluationReview: reviewRef },
      };
      taskset.contentHash = computeTasksetHash(taskset);
      taskset.readiness = { ...taskset.readiness!, tasksetHash: taskset.contentHash };
      const module = path.join(directory, "training", "tasksets", taskset.id, "metrics", "aggregate.ts");
      await mkdir(path.dirname(module), { recursive: true });
      await writeFile(module, source);
      await store.upsertTaskset(taskset);
      let calls = 0;
      const evaluation = createTaskEvaluationService({ store, storeDir: directory,
        loadProfileState: async () => profileFixture("metric-head", "metric-skill"),
        modelText: async () => { calls += 1; if (calls === 1) await writeFile(module, changed); return calls % 2 ? "Goodbye friend" : "Wrong answer"; },
        modelStream: async function* () { throw new Error("Chat metric fixture must not invoke Work."); },
      });
      const model = { providerId: "custom-openai-compatible", modelId: "fixture" } as const;
      const first = await evaluation.executeBaseline({ tasksetId: taskset.id, model, reviewRef, seeds: [17, 18] });
      expect(calls).toBe(2);
      expect(first.evaluationResult).toMatchObject({ meanScore: 0.5, authoredMetric: { value: 1, includedCount: 2, policy: taskset.metrics, policyHash: contentHash(taskset.metrics) } });
      expect(first.evaluationResult.authoredMetric?.receiptRefs).toEqual(first.evaluationResult.receiptRefs);
      // Qualification must consume the authored score, never the unrelated mean,
      // and must reject stale policies or metrics copied from another population.
      expect(tasksetEvaluationScore(taskset, first.evaluationResult)).toBe(1);
      expect(() => tasksetEvaluationScore(taskset, { ...first.evaluationResult, authoredMetric: undefined })).toThrow("lacks");
      expect(() => tasksetEvaluationScore(taskset, { ...first.evaluationResult, receiptRefs: first.evaluationResult.receiptRefs.slice(1) })).toThrow("population");
      const { contentHash: metricHash, ...metricContent } = first.evaluationResult.authoredMetric!;
      const emptyMetric = { ...metricContent, value: null, includedCount: 0, excludedCount: 2, missingRewardCount: 2 };
      expect(tasksetEvaluationScore(taskset, { ...first.evaluationResult,
        authoredMetric: { ...emptyMetric, contentHash: contentHash(emptyMetric) },
      })).toBeNull();
      expect(() => tasksetEvaluationScore(taskset, { ...first.evaluationResult,
        authoredMetric: { ...emptyMetric, contentHash: metricHash },
      })).toThrow();
      expect(JSON.stringify(first)).not.toContain(source);
      expect(await store.getEvaluationResult(first.evaluationResult.id)).toEqual(first.evaluationResult);
      await expect(evaluation.execute({ tasksetId: taskset.id, taskId: "task_eval", model, seed: 19, attempt: 0 })).rejects.toThrow("pinned content hash");
      expect(calls).toBe(2);
      await writeFile(module, source);
      await writeFile(path.join(path.dirname(module), "aggregate-min.ts"), changed);
      const next: Taskset = { ...taskset, revision: 2, metrics: { ...taskset.metrics!, primaryMetric: "worst_score", customAggregator: { ...taskset.metrics!.customAggregator!, module: "metrics/aggregate-min.ts", contentHash: sha256(changed) } } };
      next.contentHash = computeTasksetHash(next);
      next.readiness = { ...next.readiness!, tasksetHash: next.contentHash };
      await store.upsertTaskset(next);
      const second = await evaluation.executeBaseline({ tasksetId: taskset.id, model, reviewRef, seeds: [17, 18] });
      expect(second.evaluationResult).toMatchObject({ meanScore: 0.5, authoredMetric: { value: 0, policy: next.metrics } });
      expect(tasksetEvaluationScore(next, second.evaluationResult)).toBe(0);
      expect(() => tasksetEvaluationScore(next, first.evaluationResult)).toThrow("policy");
      expect(second.evaluationResult.tasksetRelease.contentHash).not.toBe(first.evaluationResult.tasksetRelease.contentHash);
      expect(await store.getEvaluationResult(first.evaluationResult.id)).toEqual(first.evaluationResult);
    }));

  test("persists and reuses one real baseline over the frozen Evaluation split", async () =>
    withTrainingStore(async ({ store, directory }) => {
      const reviewRef = { id: "review-baseline", contentHash: contentHash("review-baseline") };
      const base = tasksetFixture({ ready: true });
      const taskset = {
        ...base,
        metadata: { ...base.metadata, harnessEvaluationReview: reviewRef },
      };
      taskset.contentHash = computeTasksetHash(taskset);
      await store.upsertTaskset(taskset);
      const evaluation = createTaskEvaluationService({
        store,
        storeDir: directory,
        loadProfileState: async () => profileFixture("baseline-head", "baseline-skill"),
        modelText: async () => "Goodbye friend",
        modelStream: async function* () {
          throw new Error("The chat fixture must not invoke the Work stream.");
        },
        workRuntime: {
          createSession: async () => { throw new Error("Unexpected Work session."); },
          getSession: async () => { throw new Error("Unexpected Work session read."); },
          executeWorkspaceTool: async () => { throw new Error("Unexpected Work tool."); },
          runtimeEventsForSession: async () => [],
        },
      });
      const model = { providerId: "custom-openai-compatible", modelId: "fixture" } as const;

      const first = await evaluation.executeBaseline({
        tasksetId: taskset.id,
        model,
        reviewRef,
        seeds: [17],
      });
      expect(first.reused).toBe(false);
      expect(first.evaluationResult).toMatchObject({
        attemptCount: 1,
        rewardEligibleCount: 1,
        terminalCount: 1,
        meanScore: 1,
        metadata: {
          kind: "baseline",
          sourceTasksetId: taskset.id,
          sourceTasksetHash: taskset.contentHash,
          harnessEvaluationReview: reviewRef,
        },
      });
      const second = await evaluation.executeBaseline({
        tasksetId: taskset.id,
        model,
        reviewRef,
        seeds: [17],
      });
      expect(second).toMatchObject({ reused: true, attempts: [] });
      expect(second.evaluationResult.contentHash).toBe(first.evaluationResult.contentHash);
      expect(await store.listEvaluationResults(taskset.id, "baseline")).toHaveLength(1);
    }));

  test("pins the admitted Harness before execution and compares a later candidate against the same Taskset", async () =>
    withTrainingStore(async ({ store, directory }) => {
      const taskset = tasksetFixture({ ready: true });
      await store.upsertTaskset(taskset);

      const baselineProfile = profileFixture("baseline-head", "baseline-skill");
      const candidateProfile = profileFixture("candidate-head", "candidate-skill");
      let selectedProfile = baselineProfile;
      let modelCalls = 0;
      const evaluation = createTaskEvaluationService({
        store,
        storeDir: directory,
        loadProfileState: async () => selectedProfile,
        modelText: async () => {
          modelCalls += 1;
          if (modelCalls === 1) selectedProfile = candidateProfile;
          return "Goodbye friend";
        },
        modelStream: async function* () {
          throw new Error("The chat fixture must not invoke the Work stream.");
        },
        workRuntime: {
          createSession: async () => {
            throw new Error("The chat fixture must not create Work sessions.");
          },
          getSession: async () => {
            throw new Error("The chat fixture must not read Work sessions.");
          },
          executeWorkspaceTool: async () => {
            throw new Error("The chat fixture must not execute Work tools.");
          },
          runtimeEventsForSession: async () => [],
        },
      });
      const model = {
        providerId: "custom-openai-compatible",
        modelId: "fixture",
      } as const;

      const baseline = await evaluation.execute({
        tasksetId: taskset.id,
        taskId: "task_eval",
        model,
        seed: 17,
        attempt: 0,
        resultId: "attempt_release_isolation_baseline",
      });
      expect(baseline.portable.agentSnapshot.sourceRelease?.id).toBe(
        "source-baseline-head",
      );
      expect(baseline.portable.agentSnapshot.skills[0]?.contentHash).toBe(
        contentHash("baseline-skill"),
      );
      expect(baseline.attempt.metadata.portableRunManifestRef).toEqual({
        id: baseline.portable.runManifest.id,
        contentHash: baseline.portable.runManifest.contentHash,
      });

      const candidate = await evaluation.execute({
        tasksetId: taskset.id,
        taskId: "task_eval",
        model,
        seed: 17,
        attempt: 1,
        resultId: "attempt_release_isolation_candidate",
      });
      expect(candidate.portable.agentSnapshot.sourceRelease?.id).toBe(
        "source-candidate-head",
      );
      expect(candidate.portable.agentSnapshot.skills[0]?.contentHash).toBe(
        contentHash("candidate-skill"),
      );
      expect(candidate.portable.harnessRelease.contentHash).not.toBe(
        baseline.portable.harnessRelease.contentHash,
      );
      expect(candidate.portable.tasksetRelease.contentHash).toBe(
        baseline.portable.tasksetRelease.contentHash,
      );

      const compatibility = createVerifiedHarnessCompatibilityReceipt({
        id: "compatibility-release-isolation",
        baseHarnessRelease: baseline.portable.harnessRelease,
        candidateHarnessRelease: candidate.portable.harnessRelease,
        tasksetRelease: baseline.portable.tasksetRelease,
        metadata: { fixture: "source-mutation-during-evaluation" },
      });
      expect(() =>
        assertComparableRunManifests(
          baseline.portable.runManifest,
          candidate.portable.runManifest,
          compatibility,
        )
      ).not.toThrow();
      expect(baseline.portable.evaluationResult.harnessRelease).toEqual(
        baseline.portable.runManifest.harnessRelease,
      );
      expect(candidate.portable.evaluationResult.harnessRelease).toEqual(
        candidate.portable.runManifest.harnessRelease,
      );
    }));
});

function profileFixture(head: string, skillHash: string): OpenPondProfileState {
  return {
    mode: "local",
    repoPath: "/tmp/openpond-profile-fixture",
    activeProfile: "default",
    sourcePath: "/tmp/openpond-profile-fixture/profiles/default",
    manifestPath: null,
    agents: [],
    skills: [
      {
        name: "fixture-skill",
        description: "Portable Evaluation isolation fixture.",
        path: "skills/fixture-skill/SKILL.md",
        scope: "profile",
        enabled: true,
        sourcePath: "/tmp/openpond-profile-fixture/profiles/default/skills/fixture-skill/SKILL.md",
        charCount: 32,
        sourceHash: skillHash,
        validationStatus: "valid",
        validationMessages: [],
        resourceFiles: [],
      },
    ],
    evals: [],
    git: {
      isRepo: true,
      branch: "develop",
      head,
      shortHead: head,
      dirty: false,
      upstream: null,
      ahead: 0,
      behind: 0,
      remoteUrl: null,
      files: [],
      error: null,
    },
    catalog: {
      actionCount: 0,
      generatedAt: null,
      manifestPath: null,
      registryPath: null,
      stale: false,
      error: null,
    },
    skillCatalog: {
      skillCount: 1,
      generatedAt: null,
      stale: false,
      error: null,
    },
    actionCatalog: [],
    sourceSetupRequirements: [],
    setupGate: {
      status: "ready",
      requirementCount: 0,
      blockingCount: 0,
      optionalMissingCount: 0,
      readyCount: 0,
      requirements: [],
      blockingRequirements: [],
    },
    diff: {
      changedAgents: [],
      newAgents: [],
      deletedAgents: [],
      changedSkills: [],
      changedActions: [],
      changedExtensions: [],
      setupChanges: [],
      envRequirementChanges: [],
      files: [],
    },
    hosted: null,
    summary: {
      state: "ready",
      message: "Fixture profile is ready.",
      agentCount: 0,
      actionCount: 0,
      defaultAction: null,
      checkFresh: true,
      checkStaleReason: null,
      localHead: head,
      hostedHead: null,
    },
    lastCheck: null,
    error: null,
  };
}
