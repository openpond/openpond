import { describe, expect, test } from "vitest";

import { harnessRefinerBenchmarkV3Release } from "@openpond/evals";
import { gradeAttempt } from "@openpond/taskset-sdk";

describe("Harness Refiner v3 Taskset", () => {
  test("makes every scored criterion traceable to policy-visible task material", () => {
    expect(harnessRefinerBenchmarkV3Release.id).toBe("harness-refiner-20260819-v3");
    expect(harnessRefinerBenchmarkV3Release.environment.limits).toEqual({
      maxToolTurns: 24,
      maxToolCalls: 40,
      maxIdenticalToolCalls: 3,
      maxToolCallsPerName: {
        web_fetch: 12,
        web_search: 8,
      },
    });
    expect(harnessRefinerBenchmarkV3Release.policy.policyVisibleFields).toContain("evaluationCriteria");
    for (const task of harnessRefinerBenchmarkV3Release.tasks) {
      expect(task.evaluationCriteria?.length).toBeGreaterThan(0);
      for (const criterion of task.evaluationCriteria ?? []) {
        expect(criterion.scorerIds.length).toBeGreaterThan(0);
        for (const source of criterion.sourceRefs) {
          if (source.source === "prompt") {
            expect(source.path).toBe("input.prompt");
            expect(task.input.prompt).toContain(source.quoteOrAnchor);
          }
        }
      }
      if (task.tags.includes("artifact-verification")) {
        expect(task.evaluationCriteria?.some((criterion) => criterion.kind === "artifact_structure")).toBe(true);
        expect(task.evaluationCriteria?.some((criterion) => criterion.kind === "semantic_quality")).toBe(true);
      }
    }
  });

  test("retains a semantic failure diagnosis instead of relabeling it as a policy failure", async () => {
    const releaseTask = harnessRefinerBenchmarkV3Release.tasks.find(
      (task) => task.id === "adaptation-invoice-correction-email",
    );
    const releaseJudge = harnessRefinerBenchmarkV3Release.graders.find(
      (grader) => grader.kind === "model_judge",
    );
    if (!releaseTask || !releaseJudge || releaseJudge.kind !== "model_judge") throw new Error("v3 semantic judge fixture is missing.");
    const task = {
      schemaVersion: "openpond.taskData.v1" as const,
      id: releaseTask.id,
      clusterKey: releaseTask.clusterKey,
      split: releaseTask.split,
      input: releaseTask.input,
      expectedOutput: releaseTask.expectedOutput,
      policyVisibleContext: releaseTask.policyVisibleContext,
      privilegedContextRef: releaseTask.privilegedContextRef,
      sourceRefs: ["fixture-source"],
      tags: releaseTask.tags,
      evaluationCriteria: releaseTask.evaluationCriteria,
      metadata: {},
    };
    const judge = {
      id: releaseJudge.id,
      version: releaseJudge.version,
      label: "Semantic task coverage",
      kind: "model_judge" as const,
      weight: 1,
      hardGate: false,
      rewardEligible: true,
      privileged: true,
      rubric: "fixture rubric",
      judge: { providerId: "openai" as const, modelId: "fixture" },
      calibrationFixtureRefs: ["fixture"],
      calibrationStatus: "passed" as const,
      temperature: 0,
      metadata: {},
    };
    const grade = await gradeAttempt({
      task,
      attempt: {
        schemaVersion: "openpond.taskAttempt.v1",
        id: "attempt-v3-semantic",
        tasksetId: "taskset-v3",
        taskId: task.id,
        split: task.split,
        attempt: 0,
        seed: 1,
        modelRef: null,
        startedAt: "2026-08-19T00:00:00.000Z",
        completedAt: "2026-08-19T00:00:01.000Z",
        output: { text: "A terse, incomplete reply." },
        runtimeEventRefs: [],
        artifactRefs: [],
        privilegedOutcomeRef: null,
        infrastructureError: null,
        costUsd: null,
        latencyMs: 1,
        userInterventions: 0,
        metadata: {},
      },
      graders: [judge],
      modelJudge: async () => ({
        score: 0.4,
        passed: false,
        feedback: "The requested information is incomplete.",
        criterionScores: [{
          criterionId: `${task.id}-task-coverage`,
          score: 0.2,
          passed: false,
          feedback: "Missing requested facts.",
          evidenceRefs: [],
        }, {
          criterionId: `${task.id}-factual-grounding`,
          score: 1,
          passed: true,
          feedback: "No unsupported claims identified.",
          evidenceRefs: [],
        }],
      }),
      now: () => "2026-08-19T00:00:02.000Z",
    });

    expect(grade).toMatchObject({
      score: 0.4,
      passed: false,
      failureClass: null,
      diagnosis: {
        terminalClass: "completed",
        primaryCauseCode: "semantic_completeness_failure",
        rewardEligible: true,
      },
    });
  });
});
