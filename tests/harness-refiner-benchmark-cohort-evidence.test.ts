import { createHash } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import type { Taskset } from "@openpond/contracts";
import { contentHash } from "@openpond/harness";
import { afterEach, describe, expect, test } from "vitest";

import {
  buildHarnessRefinerBenchmarkCohortEvidence,
} from "../apps/server/src/training/harness-refiner-benchmark-cohort-evidence.js";
import type {
  BenchmarkAttemptEvidence,
} from "../apps/server/src/training/harness-refiner-benchmark-service-support.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) =>
    rm(directory, { force: true, recursive: true })
  ));
});

async function evidence(input: {
  id: string;
  taskId: string;
  failures: string[];
  passed?: boolean;
}): Promise<BenchmarkAttemptEvidence> {
  const directory = await mkdtemp(path.join(os.tmpdir(), "openpond-cohort-"));
  temporaryDirectories.push(directory);
  const tracePath = path.join(directory, "runtime-trace.json");
  const trace = JSON.stringify({
    steps: input.failures.map((toolName, index) => ({
      kind: "tool",
      name: toolName,
      turn: index + 1,
      ok: false,
      output: `Malformed ${toolName} request`,
    })),
  });
  await writeFile(tracePath, trace, "utf8");
  const grade = {
    schemaVersion: "openpond.gradeResult.v1",
    id: `grade-${input.id}`,
    attemptId: input.id,
    graderSetHash: "a".repeat(64),
    score: input.passed === false ? 0 : 1,
    passed: input.passed !== false,
    components: [],
    failureClass: input.passed === false ? "policy_failure" : null,
    feedback: [input.passed === false ? "A requested field was omitted." : "Passed."],
    rewardEligible: input.passed !== false,
    createdAt: "2026-08-10T00:00:01.000Z",
  };
  return {
    attempt: {
      schemaVersion: "openpond.taskAttempt.v1",
      id: input.id,
      tasksetId: "taskset",
      taskId: input.taskId,
      split: "validation",
      attempt: 0,
      seed: 17,
      modelRef: null,
      startedAt: "2026-08-10T00:00:00.000Z",
      completedAt: "2026-08-10T00:00:01.000Z",
      output: {
        text: `Completed ${input.taskId}`,
        requiredOutputs: [],
        outputsPassed: true,
        toolFailureCount: input.failures.length,
      },
      runtimeEventRefs: [],
      artifactRefs: [],
      privilegedOutcomeRef: null,
      infrastructureError: null,
      costUsd: 0.01,
      latencyMs: 1_000,
      userInterventions: 0,
      metadata: { usage: { promptTokens: 10, completionTokens: 5, totalTokens: 15 } },
    },
    grade,
    artifacts: [{
      schemaVersion: "openpond.taskAttemptArtifact.v1",
      id: `artifact-${input.id}`,
      tasksetId: "taskset",
      taskId: input.taskId,
      attemptId: input.id,
      kind: "runtime_trace",
      path: tracePath,
      mediaType: "application/json",
      sha256: createHash("sha256").update(trace).digest("hex"),
      sizeBytes: Buffer.byteLength(trace),
      createdAt: "2026-08-10T00:00:01.000Z",
      metadata: {},
    }],
    receiptContentHash: contentHash({ attemptId: input.id }),
  } as unknown as BenchmarkAttemptEvidence;
}

describe("Harness Refiner benchmark cohort evidence", () => {
  test("anchors the Refiner on a failure repeated across distinct tasks", async () => {
    const taskset = {
      tasks: [
        {
          id: "artifact-a",
          split: "validation",
          input: { prompt: "Create and verify one fact-distinct artifact." },
          expectedOutput: { deliverable: "pdf" },
          policyVisibleContext: {},
          tags: ["artifact-verification"],
        },
        {
          id: "artifact-b",
          split: "validation",
          input: { prompt: "Create and verify a second fact-distinct artifact." },
          expectedOutput: { deliverable: "spreadsheet" },
          policyVisibleContext: {},
          tags: ["artifact-verification"],
        },
        {
          id: "research-a",
          split: "validation",
          input: { prompt: "Research a fact-distinct current topic." },
          expectedOutput: { deliverable: "report" },
          policyVisibleContext: {},
          tags: ["research-efficiency"],
        },
      ],
    } as unknown as Taskset;
    const cohort = await buildHarnessRefinerBenchmarkCohortEvidence({
      taskset,
      adaptationAttempts: [
        await evidence({ id: "attempt-a", taskId: "artifact-a", failures: ["work_write_file"] }),
        await evidence({ id: "attempt-b", taskId: "artifact-b", failures: ["work_write_file", "web_fetch"] }),
        await evidence({ id: "attempt-c", taskId: "research-a", failures: ["work_write_file"] }),
      ],
    });

    expect(cohort.schemaVersion).toBe(
      "openpond.harnessRefinerBenchmarkCohortEvidence.v2",
    );
    expect(cohort.crossTaskToolFailureGroups[0]).toEqual({
      toolName: "work_write_file",
      distinctTaskCount: 3,
      occurrenceCount: 3,
      taskIds: ["artifact-a", "artifact-b", "research-a"],
    });
    expect(cohort.primaryEvidenceAnchor).toEqual({
      attemptId: "attempt-a",
      taskId: "artifact-a",
      reason: "repeated_cross_task_tool_failure",
    });
    expect(cohort.behaviorFamilies).toMatchObject([
      { behaviorFamily: "artifact-verification", attemptCount: 2 },
      { behaviorFamily: "research-efficiency", attemptCount: 1 },
    ]);
    expect(cohort.attempts[0]).toMatchObject({
      request: "Create and verify one fact-distinct artifact.",
      assistantOutput: "Completed artifact-a",
      evaluationCriteria: { deliverable: "pdf" },
    });
  });
});
