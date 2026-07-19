import { describe, expect, test } from "vitest";
import { TasksetSchema } from "@openpond/contracts";
import { computeTasksetHash, gradeAttempt } from "../packages/taskset-sdk/src";

import { runNormalizedAgentEvaluation } from "../apps/server/src/runtime/create-pipeline/agent-evaluation";
import { createTasksetRef } from "../apps/server/src/training/create-improve-taskset-lineage";
import { createImproveRunFixture } from "./helpers/create-improve-fixtures";
import { proposalFixture, tasksetFixture } from "./helpers/training-fixtures";

describe("Agent Eval normalization", () => {
  test("preserves publish gates, counts, source commits, traces, and failure status", async () => {
    const run = createImproveRunFixture({
      operation: "improve",
      state: "evaluating",
    });
    const receipt = await runNormalizedAgentEvaluation({
      run,
      cwd: "/profile/agent",
      sourceRef: "profiles/default/agents/support",
      sourceCommit: "a".repeat(40),
      sourceBranch: "main",
      candidateId: "agent_candidate_fixture",
      subject: "active",
      timestamp: "2026-07-16T12:00:00.000Z",
      execute: async () => ({
        code: 1,
        stdout: JSON.stringify({
          schemaVersion: "0.0.1",
          schema: "openpond.agent.eval-results.v1",
          project: { name: "Support", version: "1.0.0" },
          source: {
            configPath: "openpond-agent.config.ts",
            configHash: "config-hash",
          },
          summary: { total: 2, passed: 1, failed: 1 },
          publishGate: {
            status: "failed",
            total: 2,
            passed: 1,
            failed: 1,
            blockingFailures: ["corrected behavior"],
          },
          results: [
            {
              name: "existing behavior",
              status: "passed",
              traceArtifactRef: ".openpond/traces/existing.jsonl",
              artifacts: [],
            },
            {
              name: "corrected behavior",
              status: "failed",
              traceArtifactRef: ".openpond/traces/corrected.jsonl",
              artifacts: ["reports/corrected.json"],
              error: "Expected corrected response.",
            },
          ],
        }),
        stderr: "",
        timedOut: false,
        stdoutTruncated: false,
        stderrTruncated: false,
      }),
    });

    expect(receipt).toMatchObject({
      evaluatorKind: "agent_sdk",
      subject: "active",
      sourceCommit: "a".repeat(40),
      sourceBranch: "main",
      status: "failed",
      publishGate: "failed",
      summaryCounts: { total: 2, passed: 1, failed: 1 },
      evalRefs: ["existing behavior", "corrected behavior"],
    });
    expect(receipt.artifactRefs).toContain(
      "profiles/default/agents/support/.openpond/traces/corrected.jsonl",
    );
    expect(receipt.metadata).toMatchObject({
      publishGate: {
        blockingFailures: ["corrected behavior"],
      },
    });
  });

  test("runs active and candidate through the same private Agent Taskset contract", async () => {
    const base = tasksetFixture({ ready: true });
    const unhashed = TasksetSchema.parse({
      ...base,
      environment: {
        ...base.environment,
        kind: "agent",
        entrypoint: "chat",
        metadata: { executor: "openpond-agent-sdk" },
      },
      capabilities: {
        ...base.capabilities,
        taskKind: "single_agent",
        requiresState: true,
      },
      contentHash: "00000000",
      readiness: null,
      status: "needs_review",
    });
    const taskset = TasksetSchema.parse({
      ...unhashed,
      contentHash: computeTasksetHash(unhashed),
    });
    const tasksetRef = createTasksetRef({
      taskset,
      proposal: proposalFixture(),
      evidenceSnapshotIds: ["evidence_snapshot_fixture"],
      approvedAt: "2026-07-16T12:00:00.000Z",
    });
    const run = createImproveRunFixture({
      operation: "improve",
      state: "evaluating",
      tasksetRef,
    });
    const actionInputs: string[] = [];
    const grade = async (input: Parameters<NonNullable<Parameters<typeof runNormalizedAgentEvaluation>[0]["gradeAttempt"]>>[0]) => {
      const task = taskset.tasks.find((candidate) => candidate.id === input.taskId)!;
      return gradeAttempt({ task, attempt: input.attempt, graders: taskset.graders });
    };
    const executeFor = (text: string) => async (input: Parameters<NonNullable<Parameters<typeof runNormalizedAgentEvaluation>[0]["execute"]>>[0]) => {
      if (input.command === "eval") {
        return commandResult(JSON.stringify({
          summary: { total: 0, passed: 0, failed: 0 },
          publishGate: { status: "passed", total: 0, passed: 0, failed: 0, blockingFailures: [] },
          results: [],
        }));
      }
      actionInputs.push(input.args?.at(-1) ?? "");
      return commandResult(JSON.stringify({
        result: { text },
        traceArtifactRef: ".openpond/traces/taskset.jsonl",
      }));
    };
    const common = {
      run,
      sourceRef: "profiles/default/agents/support",
      sourceBranch: "main",
      candidateId: "agent_candidate_fixture",
      taskset,
      gradeAttempt: grade,
      timestamp: "2026-07-16T12:00:00.000Z",
    } as const;
    const active = await runNormalizedAgentEvaluation({
      ...common,
      cwd: "/profile/active",
      sourceCommit: "a".repeat(40),
      subject: "active",
      execute: executeFor("The old incorrect response."),
    });
    const candidate = await runNormalizedAgentEvaluation({
      ...common,
      cwd: "/profile/candidate",
      sourceCommit: "b".repeat(40),
      subject: "candidate",
      execute: executeFor("Goodbye friend"),
    });

    expect(active).toMatchObject({
      tasksetId: taskset.id,
      tasksetHash: taskset.contentHash,
      status: "failed",
      summaryCounts: { total: 1, passed: 0, failed: 1 },
      metadata: { trustedTasksetExecution: true, tasksetRevision: taskset.revision },
    });
    expect(candidate).toMatchObject({
      tasksetId: taskset.id,
      tasksetHash: taskset.contentHash,
      status: "passed",
      summaryCounts: { total: 1, passed: 1, failed: 0 },
      metadata: { trustedTasksetExecution: true, tasksetRevision: taskset.revision },
    });
    expect(active.metadata.executionContractHash).toBe(candidate.metadata.executionContractHash);
    expect(active.taskAttemptRefs).not.toEqual(candidate.taskAttemptRefs);
    expect(actionInputs).toHaveLength(2);
    expect(actionInputs.every((value) => value.includes("Say goodbye"))).toBe(true);
    expect(actionInputs.every((value) => !value.includes("Goodbye friend"))).toBe(true);
  });
});

function commandResult(stdout: string) {
  return {
    code: 0,
    stdout,
    stderr: "",
    timedOut: false,
    stdoutTruncated: false,
    stderrTruncated: false,
  };
}
