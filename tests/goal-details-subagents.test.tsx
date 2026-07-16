import { describe, expect, test } from "vitest";
import { SubagentRunSchema, type SubagentRun } from "@openpond/contracts";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { GoalDetailsView } from "../apps/web/src/components/goal/GoalDetailsView";
import type {
  SubagentFinalResultSummary,
  SubagentRuntimeStatus,
} from "../apps/web/src/lib/subagent-runtime";

describe("GoalDetailsView subagents", () => {
  test("renders the compact child conversation status", () => {
    const html = renderToStaticMarkup(
      createElement(GoalDetailsView, {
        createRuntime: null,
        goalRuntime: {
          objective: "Ship simple subagent orchestration",
          status: "active",
          subagents: null,
          timeUsedSeconds: 42,
          tokensUsed: 1200,
          tokenBudget: 5000,
          actionLabel: "Pursuing goal",
          timeLabel: "42s",
          label: "Goal 42s",
          detail: "Active",
          tooltip: "Goal runtime: 42 seconds. Active.",
          tone: "active",
        },
        subagentRuntime: subagentRuntimeFixture(),
      }),
    );

    expect(html).toContain("Subagents");
    expect(html).toContain("Latest update");
    expect(html).toContain("Active");
    expect(html).toContain("Completed");
    expect(html).toContain("Failed");
    expect(html).toContain("Cancelled");
    expect(html).toContain("Paused");
    expect(html).toContain("Coding running: Inspecting files");
    expect(html).toContain("Implement the patch");
    expect(html).not.toContain("Task Graph");
    expect(html).not.toContain("Required failed");
  });

  test("renders cleanup and archive controls for an eligible finished child", () => {
    const runtime = subagentRuntimeFixture();
    const completedRun = runFixture({
      id: "run_done",
      childSessionId: "child_done",
      status: "completed",
      completedAt: "2026-07-07T10:00:04.000Z",
      metadata: {
        workspaceHandoff: {
          status: "captured",
          changed: true,
        },
      },
    });
    const html = renderToStaticMarkup(
      createElement(GoalDetailsView, {
        createRuntime: null,
        goalRuntime: null,
        subagentRuntime: runtimeWithRuns([completedRun]),
        onRunSubagentLifecycleAction: async () => undefined,
      }),
    );

    expect(html).toContain("Clean");
    expect(html).toContain("Archive");
  });

  test("renders compact child final results without review-harness fields", () => {
    const runtime = subagentRuntimeFixture();
    const result: SubagentFinalResultSummary = {
      runId: "run_done",
      roleId: "coding",
      status: "completed",
      objective: "Clean up insights notification behavior",
      summary: "Suppressed unchanged insight notifications.",
      findings: ["No notification is sent when the insights payload is unchanged."],
      changedFiles: ["apps/server/src/insights/insights-system.ts"],
      refs: [{ kind: "diff", id: "subagent-run:run_done:diff", label: "Insights diff" }],
      testsRun: ["pnpm test tests/insights-system.test.ts"],
      validationAttempts: ["pnpm test tests/insights-system.test.ts"],
      blockers: [],
      confidence: "high",
      importantMessages: [
        {
          id: "message_1",
          runId: "run_done",
          fromRunId: "run_done",
          kind: "handoff",
          body: "Implementation finished.",
          createdAt: "2026-07-07T10:00:03.000Z",
        },
      ],
      workspaceRetention: {
        status: "retained",
        reason: "Changed child workspace remains available for inspection.",
        retainedAt: "2026-07-07T10:00:04.000Z",
        expiresAt: "2026-07-14T10:00:04.000Z",
        retentionDays: 7,
        trigger: "child_completion",
        cleanupAfterExpiry: true,
      },
      updatedAt: "2026-07-07T10:00:04.000Z",
    };
    const html = renderToStaticMarkup(
      createElement(GoalDetailsView, {
        createRuntime: null,
        goalRuntime: null,
        subagentRuntime: { ...runtime, finalResults: [result] },
      }),
    );

    expect(html).toContain("Child Results");
    expect(html).toContain("Suppressed unchanged insight notifications.");
    expect(html).toContain("apps/server/src/insights/insights-system.ts");
    expect(html).toContain("pnpm test tests/insights-system.test.ts");
    expect(html).toContain("diff: Insights diff");
    expect(html).toContain("Workspace: retained until");
    expect(html).toContain("Child Completion");
    expect(html).toContain("Handoff: Implementation finished.");
    expect(html).not.toContain("Packet evidence");
    expect(html).not.toContain("Independent review recommended");
  });
});

function runFixture(overrides: Partial<SubagentRun> = {}): SubagentRun {
  return SubagentRunSchema.parse({
    id: "run_coding",
    parentSessionId: "session_1",
    parentTurnId: "turn_1",
    parentGoalId: "goal_1",
    childSessionId: "child_coding",
    roleId: "coding",
    objective: "Implement the patch",
    modelRef: { providerId: "zai", modelId: "glm-5.2" },
    isolationMode: "copy_on_write",
    toolPolicy: "workspace_write",
    background: true,
    peerMessages: "goal_scoped",
    status: "running",
    progress: {
      latestMeaningfulActivity: "Inspecting files",
      updatedAt: "2026-07-07T10:00:01.000Z",
    },
    createdAt: "2026-07-07T10:00:00.000Z",
    startedAt: "2026-07-07T10:00:01.000Z",
    metadata: {
      usage: {
        totalTokens: 1200,
        promptTokens: 800,
        completionTokens: 400,
        requestCount: 2,
      },
    },
    ...overrides,
  });
}

function subagentRuntimeFixture(): SubagentRuntimeStatus {
  return runtimeWithRuns([runFixture()]);
}

function runtimeWithRuns(runs: SubagentRun[]): SubagentRuntimeStatus {
  const activeRuns = runs.filter((run) => run.status === "queued" || run.status === "running");
  const completedRuns = runs.filter((run) => run.status === "completed");
  const failedRuns = runs.filter((run) => run.status === "failed");
  const cancelledRuns = runs.filter((run) => run.status === "cancelled");
  const needsResumeRuns = runs.filter((run) => run.status === "needs_resume");
  const terminalRuns = [...completedRuns, ...failedRuns, ...cancelledRuns];
  const latestRun = runs[0] ?? null;
  return {
    sessionId: "session_1",
    runs,
    activeRuns,
    completedRuns,
    failedRuns,
    cancelledRuns,
    needsResumeRuns,
    terminalRuns,
    latestRun,
    latestMeaningfulUpdate: latestRun
      ? {
          runId: latestRun.id,
          roleId: latestRun.roleId,
          status: latestRun.status,
          message: latestRun.progress.latestMeaningfulActivity ?? latestRun.objective,
          updatedAt: latestRun.updatedAt ?? latestRun.startedAt ?? latestRun.createdAt,
        }
      : null,
    activeCount: activeRuns.length,
    completedCount: completedRuns.length,
    failedCount: failedRuns.length,
    cancelledCount: cancelledRuns.length,
    needsResumeCount: needsResumeRuns.length,
    terminalCount: terminalRuns.length,
    usage: {
      totalTokens: 1200,
      promptTokens: 800,
      completionTokens: 400,
      requestCount: 2,
    },
    blockers: [],
    evidenceRefs: [],
    finalResults: [],
    testsRunCount: 0,
    label: activeRuns.length ? `${activeRuns.length} child running` : `${terminalRuns.length} child finished`,
    tooltip: "Coding: Inspecting files",
  };
}
