import { describe, expect, test, vi } from "vitest";
import {
  ModelEvaluationReceiptSchema,
  ModelEvaluationStopReceiptSchema,
  summarizeModelEvaluationTaskEfficiency,
} from "@openpond/contracts";
import {
  buildArtifactManifest,
  createRewardReceipt,
  createVerifierSetRelease,
} from "@openpond/evals";

import {
  BenchmarkEvidenceSnapshot,
  BenchmarkSpendBudget,
  assertBenchmarkAttemptInfrastructureValid,
  benchmarkAttemptsInfrastructureValid,
  benchmarkAttemptInfrastructureValid,
  benchmarkEfficiency,
  createHarnessRefinerExecutionPlan,
  totalPlannedAttempts,
  totalPlannedTasks,
} from "../apps/server/src/training/harness-refiner-benchmark-protocol.js";
import {
  frozenToolEvidence,
  loadCompletedBenchmarkStage,
} from "../apps/server/src/training/harness-refiner-benchmark-service-support.js";
import { benchmarkLineage } from
  "../apps/server/src/training/harness-refiner-benchmark-lineage.js";

describe("Harness Refiner benchmark protocol", () => {
  test("derives the four-stage forty-attempt plan from the admitted Taskset", () => {
    const tasks = [
      ...Array.from({ length: 10 }, (_, index) => ({
        id: `adaptation-${index}`,
        split: "validation",
      })),
      ...Array.from({ length: 10 }, (_, index) => ({
        id: `held-out-${index}`,
        split: "frozen_eval",
      })),
    ];
    const plan = createHarnessRefinerExecutionPlan({
      taskset: {
        benchmark: {
          adaptationSplit: "validation",
          evaluationSplit: "frozen_eval",
        },
        tasks,
      } as never,
      seeds: [17],
      repetitions: 1,
    });

    expect(plan.map((stage) => [stage.stage, stage.attemptCount])).toEqual([
      ["adaptation", 10],
      ["baseline", 10],
      ["candidate_adaptation", 10],
      ["candidate", 10],
    ]);
    expect(totalPlannedAttempts(plan)).toBe(40);
    expect(totalPlannedTasks(plan)).toBe(20);
  });

  test("admits one sequential treatment trajectory per Model Run", () => {
    const taskset = {
      benchmark: {
        adaptationSplit: "validation",
        evaluationSplit: "frozen_eval",
      },
      tasks: [
        { id: "adaptation", split: "validation" },
        { id: "held-out", split: "frozen_eval" },
      ],
    } as never;
    expect(() => createHarnessRefinerExecutionPlan({
      taskset,
      seeds: [17, 23],
      repetitions: 1,
    })).toThrow(/one admitted seed and one trajectory repetition/i);
    expect(() => createHarnessRefinerExecutionPlan({
      taskset,
      seeds: [17],
      repetitions: 2,
    })).toThrow(/one admitted seed and one trajectory repetition/i);
  });

  test("passes a task only when its selected refined attempt uses fewer tokens", () => {
    const attempt = (input: {
      attemptId: string;
      phase: "baseline" | "candidate" | "adaptation" | "candidate_adaptation";
      taskId: string;
      totalTokens: number;
      startedAt?: string;
    }) => ({
      ...input,
      sessionId: null,
      turnId: null,
      passed: true,
      score: 1,
      failureClass: null,
      inputTokens: input.totalTokens,
      outputTokens: 0,
      latencyMs: 1,
      costUsd: 0.01,
      startedAt: input.startedAt ?? "2026-08-10T21:00:00.000Z",
    });
    const result = summarizeModelEvaluationTaskEfficiency({
      targetTaskCount: 3,
      attempts: [
        attempt({
          attemptId: "held-out-lower-baseline",
          phase: "baseline",
          taskId: "held-out-lower",
          totalTokens: 100,
        }),
        attempt({
          attemptId: "held-out-lower-discarded",
          phase: "candidate",
          taskId: "held-out-lower",
          totalTokens: 150,
          startedAt: "2026-08-10T20:00:00.000Z",
        }),
        attempt({
          attemptId: "held-out-lower-selected",
          phase: "candidate",
          taskId: "held-out-lower",
          totalTokens: 80,
        }),
        attempt({
          attemptId: "held-out-equal-baseline",
          phase: "baseline",
          taskId: "held-out-equal",
          totalTokens: 50,
        }),
        attempt({
          attemptId: "held-out-equal-refined",
          phase: "candidate",
          taskId: "held-out-equal",
          totalTokens: 50,
        }),
        attempt({
          attemptId: "adaptation-higher-baseline",
          phase: "adaptation",
          taskId: "adaptation-higher",
          totalTokens: 200,
        }),
        attempt({
          attemptId: "adaptation-higher-refined",
          phase: "candidate_adaptation",
          taskId: "adaptation-higher",
          totalTokens: 220,
        }),
      ],
    });

    expect(result.summary).toMatchObject({
      target: "all_tasks_lower",
      targetTaskCount: 3,
      comparedTaskCount: 3,
      passedTaskCount: 1,
      failedTaskCount: 2,
      lowerTaskCount: 1,
      higherTaskCount: 1,
      unchangedTaskCount: 1,
      baselineTokens: 350,
      refinedTokens: 350,
      tokenDelta: 0,
      complete: true,
      passed: false,
      cohorts: {
        adaptation: {
          targetTaskCount: 1,
          passedTaskCount: 0,
          failedTaskCount: 1,
        },
        heldOut: {
          targetTaskCount: 2,
          passedTaskCount: 1,
          failedTaskCount: 1,
        },
      },
    });
    expect(result.pairs).toHaveLength(3);
    expect(() => ModelEvaluationReceiptSchema.shape.taskEfficiency
      .unwrap()
      .parse(result.summary)).not.toThrow();
  });

  test("records web evidence once and replays the exact immutable result", async () => {
    const snapshot = new BenchmarkEvidenceSnapshot();
    const live = vi.fn(async () => ({
      ok: true,
      contentText: "authoritative result",
      metadata: {},
    }));
    const recorded = await snapshot.execute({
      mode: "record",
      cohort: "held_out",
      taskId: "held-out-1",
      toolName: "web_search",
      args: { query: "official source" },
      execute: live,
    });
    const replayed = await snapshot.execute({
      mode: "replay",
      cohort: "held_out",
      taskId: "held-out-1",
      toolName: "web_search",
      args: { query: "official source" },
      execute: async () => { throw new Error("live search must not run"); },
    });

    expect(live).toHaveBeenCalledOnce();
    expect(replayed).toEqual(recorded);
    expect(snapshot.manifest().observations).toHaveLength(1);
  });

  test("restores durable web evidence without invoking the live provider", async () => {
    const recorded = new BenchmarkEvidenceSnapshot();
    await recorded.execute({
      mode: "record",
      cohort: "adaptation",
      taskId: "adaptation-1",
      toolName: "web_fetch",
      args: { url: "https://example.test/source" },
      execute: async () => ({
        toolCallId: "call-1",
        name: "web_fetch",
        ok: true,
        contentText: "frozen page",
      }),
    });
    const restored = new BenchmarkEvidenceSnapshot(recorded.manifest().observations);
    const live = vi.fn(async () => {
      throw new Error("live provider must stay disabled during replay");
    });

    const replayed = await restored.execute({
      mode: "replay",
      cohort: "adaptation",
      taskId: "adaptation-1",
      toolName: "web_fetch",
      args: { url: "https://example.test/source" },
      execute: live,
    });

    expect(replayed.contentText).toBe("frozen page");
    expect(live).not.toHaveBeenCalled();
  });

  test("replays the frozen ordinal when model-authored web arguments drift", async () => {
    const snapshot = new BenchmarkEvidenceSnapshot();
    await snapshot.execute({
      mode: "record",
      cohort: "held_out",
      taskId: "held-out-1",
      toolName: "web_search",
      args: { query: "original primary source" },
      execute: async () => ({
        toolCallId: "call-1",
        name: "web_search",
        ok: true,
        contentText: "frozen result",
      }),
    });

    await expect(snapshot.execute({
      mode: "replay",
      cohort: "held_out",
      taskId: "held-out-1",
      toolName: "web_search",
      args: { query: "different source" },
      execute: async () => { throw new Error("live provider must stay disabled"); },
    })).resolves.toMatchObject({ ok: true, contentText: "frozen result" });
  });

  test("rebinds frozen evidence to the candidate model's current tool-call id", async () => {
    const snapshot = new BenchmarkEvidenceSnapshot();
    await snapshot.execute({
      mode: "record",
      cohort: "held_out",
      taskId: "held-out-1",
      toolName: "web_search",
      args: { query: "baseline wording" },
      execute: async () => ({
        toolCallId: "baseline-call-id",
        name: "web_search",
        ok: true,
        contentText: "frozen result bytes",
      }),
    });

    const replay = frozenToolEvidence(snapshot, "replay", "held_out");
    await expect(replay.execute({
      taskId: "held-out-1",
      callId: "candidate-call-id",
      toolName: "web_search",
      args: { query: "candidate wording" },
      execute: async () => { throw new Error("live provider must stay disabled"); },
    })).resolves.toMatchObject({
      toolCallId: "candidate-call-id",
      name: "web_search",
      ok: true,
      contentText: "frozen result bytes",
    });
  });

  test("turns extra candidate web calls into deterministic frozen-evidence exhaustion", async () => {
    const replay = frozenToolEvidence(
      new BenchmarkEvidenceSnapshot(),
      "replay",
      "held_out",
    );

    await expect(replay.execute({
      taskId: "held-out-1",
      callId: "candidate-extra-call-id",
      toolName: "web_fetch",
      args: { url: "https://example.test/unrecorded" },
      execute: async () => { throw new Error("live provider must stay disabled"); },
    })).resolves.toMatchObject({
      toolCallId: "candidate-extra-call-id",
      name: "web_fetch",
      ok: false,
      contentText: expect.stringContaining("Do not call web tools again"),
    });
  });

  test("enforces spend and computes publication accounting", () => {
    const budget = new BenchmarkSpendBudget(1);
    budget.charge(0.4, "baseline");
    expect(() => budget.charge(0.7, "candidate")).toThrow("maximum spend");
    expect(benchmarkEfficiency({
      baselineTokens: 1_000,
      candidateTokens: 700,
      refinerTokens: 120,
      graderTokens: 30,
    })).toEqual({
      grossForegroundTokenSavings: 300,
      overheadTokens: 150,
      firstPassNetTokenSavings: 150,
      breakEvenReuseCount: 1,
      amortizedTokenSavings: 2_850,
      amortizedReuseCount: 10,
    });
  });

  test("rejects an unlimited or invalid spend ceiling", () => {
    expect(() => new BenchmarkSpendBudget(0)).toThrow("positive finite number");
    expect(() => new BenchmarkSpendBudget(Number.NaN)).toThrow("positive finite number");
  });

  test("continues enforcing spend from a durable checkpoint", () => {
    const budget = new BenchmarkSpendBudget(1, 0.75);
    budget.charge(0.2, "resumed candidate");
    expect(budget.observedSpendUsd).toBeCloseTo(0.95);
    expect(() => budget.charge(0.06, "resumed grader")).toThrow("maximum spend");
  });

  test("fails closed when a stage has no authoritative price", () => {
    const budget = new BenchmarkSpendBudget(1);
    expect(() => budget.charge(null, "Refiner")).toThrow("spend ceiling cannot be enforced");
  });

  test("admits the complete benchmark lineage written into terminal receipts", () => {
    const hash = "a".repeat(64);
    expect(ModelEvaluationReceiptSchema.shape.lineage.parse({
      adaptationEvidenceHash: hash,
      refinerInputHash: hash,
      refinerOutcomeHash: hash,
      validationHash: hash,
      applyReceiptHash: hash,
      candidateRelease: { id: "candidate-release", contentHash: hash },
      valid: true,
    })).toMatchObject({ refinerInputHash: hash });
  });

  test("reduces full candidate Harness releases to immutable lineage refs", async () => {
    const hash = "a".repeat(64);
    const store = {
      listHarnessImprovementArtifacts: vi.fn(async () => []),
    };
    const fullCandidateRelease = {
      id: "candidate-release",
      contentHash: hash,
      schemaVersion: "openpond.harnessRelease.v2",
      agentSnapshot: { id: "snapshot", contentHash: hash },
    };
    const lineage = await benchmarkLineage({
      store: store as never,
      workspaceId: "benchmark-workspace",
      adaptationAttempts: [],
      completedSteps: [],
      candidateRelease: fullCandidateRelease,
      refinerInputHash: hash,
    });

    expect(lineage.candidateRelease).toEqual({
      id: "candidate-release",
      contentHash: hash,
    });
    expect(() => ModelEvaluationReceiptSchema.shape.lineage.parse(lineage)).not.toThrow();
  });

  test("restores the stage matching both its phase and Harness release", async () => {
    const baselineHash = "b".repeat(64);
    const candidateHash = "c".repeat(64);
    const receiptHash = "d".repeat(64);
    const taskIds = ["held-out-1"];
    const run = (phase: "baseline" | "candidate", harnessHash: string) => ({
      id: `${phase}-run`,
      phase,
      metadata: { parentModelRunId: "model-run" },
      protocol: { split: "frozen_eval", taskIds },
      harnessRelease: { id: `${phase}-harness`, contentHash: harnessHash },
      attemptCount: 1,
    });
    const canonicalEvidence = (id: string, score: 0 | 1) => {
      const attemptRef = { id: `receipt-${id}`, contentHash: receiptHash };
      const artifactManifest = buildArtifactManifest({
        id: `artifact-manifest-${id}`,
        attemptRef,
        requiredOutputs: [],
        collectedArtifacts: [],
        createdAt: "2026-08-17T00:00:00.000Z",
      });
      const verifierSet = createVerifierSetRelease({
        schemaVersion: "openpond.verifierSetRelease.v1",
        id: `verifier-set-${id}`,
        revision: 1,
        graders: [{
          id: "fixture-verifier",
          version: "1",
          kind: "state",
          weight: 1,
          hardGate: true,
          rewardEligible: true,
          privileged: true,
          config: {},
        }],
        isolation: {
          processBoundary: "isolated_process",
          networkPolicy: "none",
          defaultTimeoutMs: 1_000,
        },
        calibrationReceiptRefs: [],
        metadata: {},
      });
      const rewardReceipt = createRewardReceipt({
        id: `reward-${id}`,
        attemptRef,
        verifierSet,
        artifactManifest,
        outcomeClass: score ? "completed" : "policy_failure",
        failureOwner: score ? null : "policy",
        components: [{
          verifierId: "fixture-verifier",
          verifierVersion: "1",
          status: "scored",
          rawScore: score,
          normalizedScore: score,
          weight: 1,
          passed: Boolean(score),
          hardGate: true,
          rewardEligible: true,
          rewardContribution: score,
          failureOwner: score ? null : "policy",
          feedback: [],
          visibleEvidenceRefs: [],
          privilegedEvidenceRefs: [],
          metadata: {},
        }],
        createdAt: "2026-08-17T00:00:00.000Z",
      });
      return { artifactManifest, rewardReceipt };
    };
    const attempt = (id: string, harnessHash: string, score: 0 | 1) => ({
      id,
      taskId: "held-out-1",
      seed: 17,
      attempt: 0,
      metadata: {
        parentModelRunId: "model-run",
        harnessCapabilityReceipt: {
          harnessRelease: { id: "harness", contentHash: harnessHash },
        },
        portableAttemptReceipt: { contentHash: receiptHash },
        portableArtifactManifest: canonicalEvidence(id, score).artifactManifest,
        portableRewardReceipt: canonicalEvidence(id, score).rewardReceipt,
      },
    });
    const grades = [
      { attemptId: "baseline-attempt", score: 1 },
      { attemptId: "candidate-attempt", score: 0 },
    ];
    const store = {
      // Candidate-first ordering reproduces the ambiguous durable lookup that
      // previously restored candidate evidence as the baseline stage.
      listBenchmarkRuns: vi.fn(async () => [
        run("candidate", candidateHash),
        run("baseline", baselineHash),
      ]),
      listTaskAttempts: vi.fn(async () => [
        attempt("baseline-attempt", baselineHash, 1),
        attempt("candidate-attempt", candidateHash, 0),
      ]),
      listGradeResultsForTaskset: vi.fn(async () => grades),
      listTaskAttemptArtifacts: vi.fn(async () => []),
    };

    const restored = await loadCompletedBenchmarkStage({
      store: store as never,
      modelRunId: "model-run",
      tasksetId: "taskset",
      plan: {
        stage: "baseline",
        split: "frozen_eval",
        taskIds,
        attemptCount: 1,
      },
    });

    expect(restored.run.phase).toBe("baseline");
    expect(restored.run.harnessRelease.contentHash).toBe(baselineHash);
    expect(restored.attempts[0]?.attempt.id).toBe("baseline-attempt");
  });

  test("admits an inconclusive stop receipt before candidate spend", () => {
    const hash = "a".repeat(64);
    const emptyUsage = { inputTokens: 0, outputTokens: 0, totalTokens: 0, costUsd: null };
    const core = {
      schemaVersion: "openpond.modelEvaluationStopReceipt.v1" as const,
      benchmarkId: "harness-refiner",
      terminalClassification: "inconclusive" as const,
      stopReason: "candidate_harness_unchanged" as const,
      reason: "Refiner produced no changed Harness candidate.",
      stoppedAfter: "refiner" as const,
      baselineHarness: { id: "baseline-harness", contentHash: hash },
      candidateHarness: { id: "baseline-harness", contentHash: hash },
      refiner: { id: "refiner-stage", contentHash: hash, outcomeCount: 1 },
      usage: {
        baseline: emptyUsage,
        adaptation: emptyUsage,
        candidateAdaptation: emptyUsage,
        candidate: emptyUsage,
        refiner: emptyUsage,
        grader: emptyUsage,
      },
      budget: { maximumSpendUsd: 1, observedSpendUsd: 0.2, enforced: true },
      evidenceSnapshot: { id: "evidence-snapshot", contentHash: hash },
      attempts: [],
    };
    expect(ModelEvaluationStopReceiptSchema.parse({
      ...core,
      contentHash: hash,
    })).toMatchObject({
      stopReason: "candidate_harness_unchanged",
      terminalClassification: "inconclusive",
    });
  });

  test("requires stop receipts to reduce full Harness releases to immutable refs", () => {
    const hash = "a".repeat(64);
    const fullHarness = {
      schemaVersion: "openpond.harnessRelease.v2",
      id: "candidate-harness",
      contentHash: hash,
      agentSnapshot: { id: "snapshot", contentHash: hash },
    };
    expect(() => ModelEvaluationStopReceiptSchema.parse({
      schemaVersion: "openpond.modelEvaluationStopReceipt.v1",
      benchmarkId: "harness-refiner",
      terminalClassification: "inconclusive",
      stopReason: "candidate_harness_unchanged",
      reason: "No changed candidate.",
      stoppedAfter: "refiner",
      baselineHarness: { id: "baseline-harness", contentHash: hash },
      candidateHarness: fullHarness,
      refiner: { id: "refiner-stage", contentHash: hash, outcomeCount: 1 },
      usage: Object.fromEntries(
        ["baseline", "adaptation", "candidateAdaptation", "candidate", "refiner", "grader"]
          .map((key) => [key, {
            inputTokens: 0,
            outputTokens: 0,
            totalTokens: 0,
            costUsd: null,
          }]),
      ),
      budget: { maximumSpendUsd: 1, observedSpendUsd: 0.2, enforced: true },
      evidenceSnapshot: { id: "evidence-snapshot", contentHash: hash },
      attempts: [],
      contentHash: hash,
    })).toThrow(/candidateHarness/);
  });

  test("rejects terminal attempts whose scores are missing because infrastructure failed", () => {
    expect(benchmarkAttemptInfrastructureValid({
      grade: { score: null, failureClass: "infrastructure_failure" },
    })).toBe(false);
    expect(benchmarkAttemptInfrastructureValid({
      grade: { score: 0, failureClass: "policy_failure" },
    })).toBe(true);
    expect(() => assertBenchmarkAttemptInfrastructureValid({
      attempt: { taskId: "task-infrastructure-failure" },
      grade: { score: null, failureClass: "infrastructure_failure" },
    }, "adaptation baseline")).toThrow(
      "Benchmark stopped after infrastructure-invalid adaptation baseline task task-infrastructure-failure",
    );
    expect(benchmarkAttemptsInfrastructureValid([
      { grade: { score: 1, failureClass: null } },
      { grade: { score: null, failureClass: "infrastructure_failure" } },
    ])).toBe(false);
    expect(benchmarkAttemptsInfrastructureValid([
      { grade: { score: 0, failureClass: "policy_failure" } },
      { grade: { score: 1, failureClass: null } },
    ])).toBe(true);
  });
});
