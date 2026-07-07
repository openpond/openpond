import { describe, expect, test } from "bun:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { SubagentRuntimeStatus } from "../apps/web/src/lib/subagent-runtime";
import { GoalDetailsView } from "../apps/web/src/components/goal/GoalDetailsView";

describe("GoalDetailsView subagents", () => {
  test("renders the child-run task graph", () => {
    const html = renderToStaticMarkup(
      createElement(GoalDetailsView, {
        createRuntime: null,
        goalRuntime: {
          objective: "Ship subagent orchestration",
          status: "active",
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
    expect(html).toContain("Task Graph");
    expect(html).toContain("zai/glm-5.2");
    expect(html).toContain("Implement the patch");
    expect(html).toContain("Parent started");
    expect(html).toContain("run_coding handoff");
  });
});

function subagentRuntimeFixture(): SubagentRuntimeStatus {
  const codingRun = {
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
    required: true,
    createdAt: "2026-07-07T10:00:00.000Z",
    startedAt: "2026-07-07T10:00:01.000Z",
    completedAt: null,
    error: null,
    report: null,
    metadata: {},
  } as const;
  const reviewRun = {
    ...codingRun,
    id: "run_review",
    childSessionId: "child_review",
    roleId: "review",
    objective: "Review the patch",
    status: "queued",
    startedAt: null,
  } as const;
  return {
    sessionId: "session_1",
    runs: [codingRun, reviewRun],
    activeRuns: [codingRun, reviewRun],
    blockedRuns: [],
    completedRuns: [],
    latestRun: codingRun,
    activeCount: 2,
    blockedCount: 0,
    completedCount: 0,
    requiredOpenCount: 2,
    usage: {
      totalTokens: 1200,
      promptTokens: 800,
      completionTokens: 400,
      requestCount: 2,
    },
    blockers: [],
    evidenceRefs: [],
    testsRunCount: 0,
    taskGraph: {
      rootId: "parent:session_1",
      nodes: [
        {
          runId: "run_coding",
          roleId: "coding",
          status: "running",
          objective: "Implement the patch",
          required: true,
          childSessionId: "child_coding",
          modelLabel: "zai/glm-5.2",
          isolationLabel: "copy on write - workspace write",
          summary: null,
          blockerCount: 0,
          evidenceCount: 1,
          testsRunCount: 0,
          createdAt: "2026-07-07T10:00:00.000Z",
          startedAt: "2026-07-07T10:00:01.000Z",
          completedAt: null,
        },
        {
          runId: "run_review",
          roleId: "review",
          status: "queued",
          objective: "Review the patch",
          required: true,
          childSessionId: "child_review",
          modelLabel: "openrouter/test-model",
          isolationLabel: "copy on write - read only",
          summary: null,
          blockerCount: 0,
          evidenceCount: 0,
          testsRunCount: 0,
          createdAt: "2026-07-07T10:00:02.000Z",
          startedAt: null,
          completedAt: null,
        },
      ],
      edges: [
        {
          id: "start:run_coding",
          fromRunId: "parent:session_1",
          toRunId: "run_coding",
          kind: "started",
          label: "Started",
          createdAt: "2026-07-07T10:00:00.000Z",
        },
        {
          id: "message:message_1:run_coding:run_review",
          fromRunId: "run_coding",
          toRunId: "run_review",
          kind: "handoff",
          label: "Handoff",
          createdAt: "2026-07-07T10:00:03.000Z",
        },
      ],
    },
    label: "2 subagents running",
    tooltip: "Subagents: Coding running, Review queued",
  };
}
