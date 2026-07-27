import {
  PrimeRolloutResultSchema,
  type LearningSignalLineage,
} from "@openpond/contracts";
import { contentHash, sha256 } from "@openpond/taskset-sdk";
import { describe, expect, test } from "vitest";

import { createMarketingRolloutLearningSignals } from "../apps/server/src/training/marketing-rollout-signals.ts";

const lineage: LearningSignalLineage = {
  datasetRelease: { id: "dataset-marketing", contentHash: sha256("dataset") },
  harnessRelease: { id: "harness-marketing", contentHash: sha256("harness") },
  evidenceSetRelease: null,
  profileRelease: { id: "profile-marketing", contentHash: sha256("profile") },
  model: {
    source: "prime_raw",
    revision: "c1899de289a04d12100db370d81485cdf75e47ca",
    artifactHash: null,
  },
  environmentHash: sha256("environment"),
  graderHash: sha256("grader"),
  toolContractHash: sha256("tools"),
  verificationReceiptHash: sha256("verification"),
};

describe("marketing rollout learning signals", () => {
  test("projects a terminal rollout into strict trajectory and reward signals", () => {
    const result = rolloutResult({ terminal: true, reward: 0.8 });
    const signals = createMarketingRolloutLearningSignals({
      result,
      lineage,
      traceRef: "training/traces/result-token-proof.json",
      traceHash: result.transcriptHash,
      graderEvidenceRefs: ["grade-result-token-proof"],
      createdAt: "2026-07-25T12:00:02.000Z",
    });

    expect(signals.map((signal) => signal.kind)).toEqual([
      "trajectory",
      "reward",
    ]);
    expect(signals[0]).toMatchObject({
      approved: true,
      taskId: "task-marketing",
      episodeId: result.resultHash,
      policyVersion: 0,
      payload: {
        terminal: true,
        failureClass: null,
        optimizerSample: {
          modelRequestId: "chatcmpl-token-proof",
          servedPolicyVersion: 0,
        },
      },
    });
    expect(signals[1]).toMatchObject({
      approved: true,
      payload: {
        reward: 0.8,
        eligible: true,
        graderEvidenceRefs: ["grade-result-token-proof"],
      },
    });
    expect(JSON.stringify(signals)).not.toContain("private-case");
  });

  test("keeps a completed zero-reward policy failure eligible without calling it a demonstration", () => {
    const result = rolloutResult({ terminal: false, reward: 0 });
    const signals = createMarketingRolloutLearningSignals({
      result,
      lineage,
      traceRef: "training/traces/result-token-proof.json",
      traceHash: result.transcriptHash,
    });

    expect(signals[0]).toMatchObject({
      kind: "trajectory",
      approved: true,
      payload: {
        terminal: false,
        failureClass: "policy_failure",
      },
    });
    expect(signals[1]).toMatchObject({
      kind: "reward",
      approved: true,
      payload: { reward: 0, eligible: true },
    });
    expect(signals.some((signal) => signal.kind === "demonstration")).toBe(false);
  });
});

function rolloutResult(input: { terminal: boolean; reward: number }) {
  const core = {
    schemaVersion: "openpond.primeRolloutResult.v1" as const,
    runId: "run-marketing",
    assignmentHash: sha256("assignment"),
    status: "succeeded" as const,
    taskId: "task-marketing",
    policyVersion: "base" as const,
    model: {
      id: "Qwen/Qwen3-0.6B",
      revision: "c1899de289a04d12100db370d81485cdf75e47ca",
    },
    samplingTraces: [{
      requestId: "chatcmpl-token-proof",
      servedModel: "Qwen/Qwen3-0.6B",
      startedAt: "2026-07-25T12:00:00.000Z",
      completedAt: "2026-07-25T12:00:01.000Z",
      durationMs: 1_000,
      requested: {
        temperature: 0.2,
        topP: 0.95,
        maxOutputTokens: 1_024,
        logprobs: true,
        tokenIds: true,
      },
      support: {
        temperature: "applied" as const,
        topP: "applied" as const,
        logprobs: "returned" as const,
        tokenIds: "returned" as const,
      },
      promptTokenIds: [1, 2],
      generatedTokenIds: [3, 4],
      generatedLogprobs: [-0.1, -0.2],
      usage: { promptTokens: 2, generatedTokens: 2 },
    }],
    optimizerSample: {
      schemaVersion: "openpond.optimizerTrainingSample.v1" as const,
      tokenIds: [1, 2, 3, 4],
      mask: [false, false, true, true],
      logprobs: [0, 0, -0.1, -0.2],
      temperatures: [0.2, 0.2, 0.2, 0.2],
      envName: "marketing-portfolio-v1",
      modelRequestId: "chatcmpl-token-proof",
      promptTokenCount: 2,
      completionTokenCount: 2,
      servedPolicyVersion: 0,
    },
    toolSequence: input.terminal
      ? ["get_portfolio_snapshot", "submit_budget_decision"] as const
      : ["get_portfolio_snapshot"] as const,
    transcriptHash: sha256("transcript"),
    grade: {
      schemaVersion: "openpond.marketingPortfolioGrade.v1" as const,
      benchmarkId: "marketing-portfolio-v1" as const,
      agentReleaseHash: sha256("agent"),
      scorerImplementationHash: sha256("scorer"),
      terminalActionId: "submit-budget-decision" as const,
      decisionAccepted: input.terminal,
      caseRef: sha256("private-case"),
      traceHash: sha256("trace"),
      reward: input.reward,
      components: {
        constraints: input.reward,
        portfolioValue: input.reward,
        riskControls: input.reward,
        rationale: input.reward,
      },
    },
    terminal: input.terminal,
    failure: null,
    completedAt: "2026-07-25T12:00:01.000Z",
  };
  return PrimeRolloutResultSchema.parse({
    ...core,
    resultHash: contentHash(core),
  });
}
