import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import {
  ModelComparisonSeriesEntrySchema,
  ModelComparisonSeriesSchema,
  ModelRunSchema,
  ModelVersionSchema,
  TasksetSchema,
  type ContinualBenchPanelRole,
  type ModelComparisonBenchmarkReceipt,
  type ModelRun,
  type Taskset,
} from "@openpond/contracts";
import { contentHash } from "@openpond/taskset-sdk";
import { describe, expect, it } from "vitest";

import { SqliteStore } from "../store/store.js";
import { createModelCurrencyProjectionService } from "./model-currency-projection-service.js";

const NOW = "2026-09-02T12:00:00.000Z";
const hash = (value: unknown) => contentHash(value);
const immutable = (id: string) => ({ id, contentHash: hash(id) });

function taskset(id: string, taskId: string): Taskset {
  const source = { schemaVersion: "openpond.trainingSource.v1" as const, id: `source-${id}`, profileId: "currency-profile", sessionId: `session-${id}`, turnIds: [`turn-${id}`], workspaceId: null, sourceHash: hash(`source-${id}`), clusterKey: `family-${taskId}`, title: id, occurredAt: NOW, consent: { status: "granted" as const, scope: "selected_turns" as const, grantedBy: "tester", grantedAt: NOW, purpose: "task_authoring_and_evaluation" }, connectedAppIds: [], secretScanStatus: "passed" as const, piiScanStatus: "passed" as const, licensingStatus: "approved" as const, metadata: {} };
  return TasksetSchema.parse({
    schemaVersion: "openpond.taskset.v1", id, revision: 1, profileId: "currency-profile", name: id, objective: id, status: "needs_review", sourceRefs: [source],
    policy: { policyVisibleFields: ["input.prompt"], privilegedFields: ["expectedOutput.passed"], hiddenGraderRefs: ["currency-grader"], connectedAppScopes: [] },
    environment: { protocolVersion: "openpond.taskEnvironment.v1", kind: "chat", entrypoint: "environment/taskset.ts", stateful: false, deterministicSeeds: true, toolNames: [], lifecycle: ["create", "reset", "step", "grade", "cleanup"], defaultTimeoutMs: 120_000, networkPolicy: "none", metadata: {} },
    capabilities: { schemaVersion: "openpond.tasksetCapabilities.v1", taskKind: "chat", supportedSignals: ["reward"], compatibleMethods: ["grpo"], rewardKinds: ["deterministic"], requiresTools: false, requiresState: false, requiresPrivilegedGrading: true, environmentPlacements: ["local", "remote"], exportable: true, portabilityBlockers: [] },
    tasks: [{ schemaVersion: "openpond.taskData.v1", id: taskId, clusterKey: `family-${taskId}`, split: "train", input: { prompt: taskId }, expectedOutput: { passed: true }, policyVisibleContext: {}, privilegedContextRef: `outcome-${taskId}`, sourceRefs: [source.id], tags: [], metadata: {} }],
    graders: [{ id: "currency-grader", version: "1", label: "grader", kind: "content", weight: 1, hardGate: false, rewardEligible: true, privileged: true, config: {}, metadata: {} }],
    graderFixtures: [{ id: `fixture-${id}`, taskId, label: "positive", output: { passed: true }, infrastructureError: null, expectedPassed: true, expectedRewardEligible: true, metadata: {} }],
    learningSignals: { demonstrations: [], preferences: [], corrections: [], feedback: [], rewards: [], labels: [] },
    authoringProvenance: { schemaVersion: "openpond.taskAuthoringProvenance.v1", model: null, modelConfig: {}, skillHash: hash("skill"), promptTemplateVersion: "currency-test.v1", evidenceHashes: [source.sourceHash], tasksetSdkVersion: "0.0.1", sourceCommit: null, repairHistory: [], createdAt: NOW },
    readiness: null, contentHash: hash(id), createdAt: NOW, updatedAt: NOW, metadata: {},
  });
}

describe("Model Currency projection", () => {
  it("preserves measuring evidence, then projects an idempotent terminal paired snapshot", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "openpond-model-currency-"));
    const store = new SqliteStore(directory);
    try {
      const panelDefinitions: Array<[string, ContinualBenchPanelRole, string | null, string]> = [
        ["p0-correction", "correction", "P0", "task-correction"],
        ["p0-sibling", "sibling_verification", "P0", "task-sibling"],
        ["p0-known", "cumulative_known", "P0", "task-known"],
        ["p1-correction", "correction", "P1", "task-p1-correction"],
        ["p1-sibling", "sibling_verification", "P1", "task-p1-sibling"],
        ["p1-known", "cumulative_known", "P1", "task-p1-known"],
        ["development", "development", null, "task-development"],
        ["retained", "retained", null, "task-retained"],
        ["frozen", "frozen_final", null, "task-frozen"],
        ["eligible", "training_eligible", null, "task-eligible"],
      ];
      const tasksets = new Map(panelDefinitions.map(([id, , , taskId]) => [id, taskset(`taskset-${id}`, taskId)]));
      for (const value of tasksets.values()) await store.upsertTaskset(value);
      const panels = panelDefinitions.map(([id, role, passLabel]) => ({ id, role, passLabel, taskset: ref(tasksets.get(id)!), familyIds: [`family-${id}`], taskCount: 1, sealedAt: NOW }));
      const protocolContent = {
        schemaVersion: "openpond.continualBenchmarkProtocol.v1" as const, id: "currency-protocol", revision: 1, ownerId: "currency-owner", createdAt: NOW, sealedAt: NOW,
        creationReceipt: immutable("creation"), predecessorSeries: null, scenarioPack: immutable("scenario"), issueFamilyLedger: immutable("ledger"), issuePacketRelease: immutable("packets"), panels,
        grader: immutable("currency-grader"), judge: { release: immutable("judge"), rubricRelease: immutable("rubric"), calibrationRelease: immutable("calibration"), model: { providerId: "codex", modelId: "judge-model" } },
        policies: { base: { kind: "base_model" as const, id: "currency-base", revision: "base-revision", contentHash: hash("base") }, master: null, externalReferences: [{ kind: "external_reference" as const, id: "frontier", model: { providerId: "codex", modelId: "frontier" }, providerRevision: "frontier-revision", contentHash: hash("frontier") }] },
        invariants: { systemPromptHash: hash("prompt"), toolSchema: immutable("tools"), application: immutable("application"), harness: immutable("harness"), runtime: immutable("runtime"), workerImage: immutable("worker"), autoRefiner: { enabled: false, release: null } },
        schedule: [
          { scheduleEntryId: "schedule-p0", ordinal: 0, label: "P0", role: "seed" as const, parentRule: "base_model" as const, trainableRank: 16, correctionPanelIds: ["p0-correction"], optimizerGroupsPerTask: 1, trajectoriesPerGroup: 4 },
          { scheduleEntryId: "schedule-p1", ordinal: 1, label: "P1", role: "daily_residual" as const, parentRule: "previous_release" as const, trainableRank: 1, correctionPanelIds: ["p1-correction"], optimizerGroupsPerTask: 1, trajectoriesPerGroup: 4 },
        ],
        evaluation: { seeds: [1, 2, 3], repetitions: 3, powerRule: immutable("power"), pairedBootstrapSamples: 1_000, confidenceLevel: 0.95 as const },
        resources: { maximumTrainingGpuSeconds: 100, maximumEvaluationGpuSeconds: 100, maximumProviderSpendUsd: 10, maximumTotalSpendUsd: 20, maximumConcurrentGroups: 1 },
        currencyThresholds: { revision: 1, requireAllAttemptsTerminal: true as const, criticalCorrectionPassRate: 1, siblingPassRate: 0.8, behavioralRetentionRate: 0.95, maximumRetainedRegressionPoints: 5, blockCriticalPriorRegression: true, authorizedClaims: ["systems_complete" as const] },
      };
      const protocol = { ...protocolContent, contentHash: hash(protocolContent) };
      const series = ModelComparisonSeriesSchema.parse({
        schemaVersion: "openpond.modelComparisonSeries.v1", id: "currency-series", profileId: "currency-profile", modelProjectId: "currency-project", name: "Currency test", objective: "Currency projection test", status: "active", revision: 2,
        productionBinding: { role: "chat_manual", roleTargetId: "currency-target" }, baseModel: { id: "currency-base", revision: "base-revision" }, seedTaskset: ref(tasksets.get("p0-correction")!), eligibleTaskPool: ref(tasksets.get("eligible")!),
        evaluationTasksets: { development: ref(tasksets.get("development")!), retained: ref(tasksets.get("retained")!), frozenFinal: ref(tasksets.get("frozen")!) }, grader: immutable("currency-grader"), benchmarkProtocol: protocol, automaticEvaluation: { enabled: true },
        residualProfile: { profileId: "currency-residual", serializedEnvelopeRank: 32, maximumEnabledRank: 17, topology: "uniform_block_masked" },
        schedule: [
          { id: "schedule-p0", ordinal: 0, label: "P0", role: "seed", parentRule: "base_model", taskSource: "seed_taskset", trainableRank: 16, minimumTasks: 1, maximumTasks: 10 },
          { id: "schedule-p1", ordinal: 1, label: "P1", role: "daily_residual", parentRule: "previous_release", taskSource: "nightly_selection", trainableRank: 1, minimumTasks: 1, maximumTasks: 10 },
        ],
        scheduleSealedAt: NOW, advancementPolicy: { id: "currency-policy", version: 1, requireCheckpoint: true, requireAppliedOptimizerUpdate: true, minimumCurrentCohortMeanImprovement: 0, maximumRetainedMeanRegression: 0.05, blockCriticalInvariantRegression: true, automaticDailyAdvancement: false }, executionPolicy: { startWhenReady: false },
        acceptedSeedEntryId: null, acceptedDailyHeadEntryId: null, promotedBindingId: null, createdBy: "currency-owner", createdAt: NOW, updatedAt: NOW,
      });
      await store.saveModelComparisonSeries(series);
      const candidate = ModelVersionSchema.parse({ schemaVersion: "openpond.modelVersion.v1", id: "currency-candidate", modelId: series.modelProjectId, profileId: series.profileId, version: 1, kind: "lora_adapter", status: "available", baseModel: { schemaVersion: "openpond.baseModelPreference.v1", modelId: series.baseModel.id, revision: series.baseModel.revision, tokenizerRevision: null, chatTemplateHash: null, modelAssetId: null, source: "managed" }, taskset: series.seedTaskset, comparisonSeriesEntry: { seriesId: series.id, entryId: "currency-entry", scheduleEntryId: "schedule-p0", releaseHash: hash("entry-release"), ordinal: 0 }, releaseGraph: { resolvedBundleHash: hash("bundle"), profileRelease: { id: "profile", revision: 1, contentHash: hash("profile") }, harnessRelease: immutable("harness"), agentRelease: null, grader: series.grader }, artifactLineageId: "currency-lineage", adapterStatus: "trained", createdAt: NOW, contentHash: hash("candidate") });
      await store.saveModelVersion(candidate);
      const entry = ModelComparisonSeriesEntrySchema.parse({ schemaVersion: "openpond.modelComparisonSeriesEntry.v1", id: "currency-entry", seriesId: series.id, profileId: series.profileId, modelProjectId: series.modelProjectId, scheduleEntryId: "schedule-p0", releaseHash: hash("entry-release"), ordinal: 0, label: "P0", role: "seed", branch: "daily", status: "candidate", parent: { kind: "base_model", id: series.baseModel.id, revision: series.baseModel.revision }, taskset: series.seedTaskset, sourceTasksets: [series.seedTaskset], taskSelection: null, trainableRank: 16, serializedEnvelopeRank: 32, enabledCumulativeRank: 16, trainableBlockId: "currency-block", residualBlocks: [{ id: "currency-block", branchOrdinal: 0, rank: 16, offsetStart: 0, offsetEnd: 16, optimizationRole: "trainable", artifactLineageId: "currency-lineage" }], attemptOrdinal: 1, priorRunAttempts: [], trainingPlanId: "currency-plan", modelRunId: "currency-training-run", modelVersionId: candidate.id, evaluations: [], decision: null, promotionBindingId: null, queuedAt: NOW, startedAt: NOW, completedAt: NOW, createdAt: NOW, updatedAt: NOW });
      await store.saveModelComparisonSeriesEntry(entry);
      const projection = createModelCurrencyProjectionService(store);

      const measuring = await projection.reconcileEntry(entry.id);
      expect(measuring).toMatchObject({ evidenceState: "measuring", criteria: { allRequiredAttemptsTerminal: false } });
      expect((await projection.reconcileEntry(entry.id))?.id).toBe(measuring?.id);

      for (const panel of panels.filter((value) => ["p0-correction", "p0-sibling", "p0-known", "development", "retained", "frozen"].includes(value.id))) {
        if (panel.role === "training_eligible") throw new Error("The test evaluation inventory cannot include the optimizer panel.");
        await store.saveModelRun(evaluationRun(series, entry, panel.id, panel.role, panel.passLabel, panel.taskset, "base_model", null, panel.role === "correction" || panel.role === "sibling_verification" ? false : true));
        await store.saveModelRun(evaluationRun(series, entry, panel.id, panel.role, panel.passLabel, panel.taskset, "model_version", candidate.id, true));
      }
      const terminal = await projection.reconcileEntry(entry.id);
      expect(terminal).toMatchObject({ evidenceState: "up_to_date", taskIds: { fixed: expect.arrayContaining(["task-correction", "task-sibling"]), regressed: [] }, criteria: { allRequiredAttemptsTerminal: true, criticalCorrectionPassRate: 1, siblingPassRate: 1, criticalPriorRegressionCount: 0 }, metrics: { behavioralRetention: 1 } });
      expect(terminal?.matches).toHaveLength(54);
      expect((await projection.reconcileEntry(entry.id))?.id).toBe(terminal?.id);
      expect(await store.listModelCurrencySnapshots({ entryId: entry.id })).toHaveLength(2);
      await expect(store.saveModelCurrencySnapshot({ ...terminal!, contentHash: hash("replacement") })).rejects.toThrow("cannot be replaced");
    } finally {
      await store.close();
      await rm(directory, { recursive: true, force: true });
    }
  });
});

function ref(taskset: Taskset) { return { id: taskset.id, revision: taskset.revision, contentHash: taskset.contentHash }; }

function evaluationRun(series: ReturnType<typeof ModelComparisonSeriesSchema.parse>, entry: ReturnType<typeof ModelComparisonSeriesEntrySchema.parse>, panelId: string, panelRole: Exclude<ContinualBenchPanelRole, "training_eligible">, passLabel: string | null, tasksetRef: { id: string; revision: number; contentHash: string }, targetKind: "base_model" | "model_version", modelVersionId: string | null, passed: boolean): ModelRun {
  const runId = `eval-${panelId}-${targetKind}`;
  const attempts = [1, 2, 3].flatMap((seed) => [0, 1, 2].map((repetition, index) => ({ attemptId: `${runId}-attempt-${seed}-${repetition}`, taskId: taskIdForPanel(panelId), seed, repetition, status: "succeeded" as const, deterministicScore: passed ? 1 : 0, passed, judgeScore: null, judgePreference: null, transcriptHash: hash(`${runId}-transcript-${index}`), traceHash: hash(`${runId}-trace-${index}`), transcriptArtifact: { artifactPath: `/evidence/${runId}.json`, jsonPointer: `/attempts/${index}/messages` }, traceArtifact: { artifactPath: `/evidence/${runId}.json`, jsonPointer: `/attempts/${index}/trace` }, latencyMs: 10, failureClass: null })));
  const receiptContent = { schemaVersion: "openpond.modelComparisonBenchmarkReceipt.v1" as const, benchmarkId: "model-comparison" as const, target: { kind: targetKind, label: targetKind === "base_model" ? series.baseModel.id : entry.label, modelVersionId, model: null }, taskset: tasksetRef, grader: series.grader, sampling: { seeds: [1, 2, 3], repetitions: 3 }, deterministic: { attemptedTaskCount: 9, completedTaskCount: 9, passedTaskCount: passed ? 9 : 0, failedTaskCount: passed ? 0 : 9, meanScore: passed ? 1 : 0, passRate: passed ? 1 : 0, passRateCi95: { level: 0.95 as const, lower: passed ? 0.7 : 0, upper: passed ? 1 : 0.3 } }, judge: null, attempts, usage: { policy: { inputTokens: 90, outputTokens: 45, totalTokens: 135, costUsd: 0.01 }, judge: null, observedSpendUsd: 0.01, evaluationGpuSeconds: 1 }, evidenceSnapshot: { id: `evidence-${runId}`, contentHash: hash(`evidence-${runId}`), artifactPath: `/evidence/${runId}.json` }, completedAt: NOW };
  const receipt = { ...receiptContent, contentHash: hash(receiptContent) } as ModelComparisonBenchmarkReceipt;
  return ModelRunSchema.parse({ schemaVersion: "openpond.modelRun.v1", id: runId, modelId: series.modelProjectId, modelVersionId, profileId: series.profileId, kind: "evaluation", status: "succeeded", method: null, destinationId: null, taskset: tasksetRef, comparisonSeriesEntry: { seriesId: series.id, entryId: entry.id, scheduleEntryId: entry.scheduleEntryId, releaseHash: entry.releaseHash, ordinal: entry.ordinal }, harnessRelease: series.benchmarkProtocol!.invariants.harness, quote: { maximumSpendUsd: 1, hourlyCostUsd: 1 }, evaluation: { benchmarkId: "model-comparison", target: receipt.target, grader: series.grader, judge: null, seeds: [1, 2, 3], repetitions: 3, maximumSpendUsd: 1, series: { id: series.id, protocol: { id: series.benchmarkProtocol!.id, revision: series.benchmarkProtocol!.revision, contentHash: series.benchmarkProtocol!.contentHash } }, panel: { id: panelId, role: panelRole, passLabel }, comparisonPair: { entryId: entry.id, parent: entry.parent, candidateModelVersionId: entry.modelVersionId! }, attemptPlan: [{ stage: "comparison", split: panelRole, taskIds: [taskIdForPanel(panelId)], attemptCount: 9 }] }, evaluationProgress: { stage: "comparison", completedAttempts: 9, totalAttempts: 9, accounting: null, evidenceSnapshot: null }, reward: null, receipt, adapterArtifactLineageId: null, failure: null, startedAt: NOW, completedAt: NOW, updatedAt: NOW });
}

function taskIdForPanel(panelId: string) { return panelId === "p0-correction" ? "task-correction" : panelId === "p0-sibling" ? "task-sibling" : panelId === "p0-known" ? "task-known" : panelId === "development" ? "task-development" : panelId === "frozen" ? "task-frozen" : "task-retained"; }
