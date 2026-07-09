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
    expect(html).toContain("Task Graph");
    expect(html).toContain("Background check");
    expect(html).toContain("Latest update");
    expect(html).toContain("Coding running: Inspecting files");
    expect(html).toContain("zai/glm-5.2");
    expect(html).toContain("Implement the patch");
    expect(html).toContain("Parent started");
    expect(html).toContain("run_coding handoff");
  });

  test("renders cleanup and archive controls for eligible terminal child runs", () => {
    const runtime = subagentRuntimeFixture();
    const acceptedRun = {
      ...runtime.runs[0]!,
      id: "run_done",
      childSessionId: "child_done",
      status: "accepted",
      review: { status: "accepted" },
      metadata: {
        workspaceHandoff: {
          status: "captured",
          changed: true,
        },
      },
    } as const;
    const html = renderToStaticMarkup(
      createElement(GoalDetailsView, {
        createRuntime: null,
        goalRuntime: null,
        subagentRuntime: {
          ...runtime,
          runs: [acceptedRun],
          terminalRuns: [acceptedRun],
          archivedRuns: [],
        },
        onRunSubagentLifecycleAction: async () => undefined,
      }),
    );

    expect(html).toContain("Clean");
    expect(html).toContain("Archive");
  });

  test("renders compact child final results", () => {
    const runtime = subagentRuntimeFixture();
    const html = renderToStaticMarkup(
      createElement(GoalDetailsView, {
        createRuntime: null,
        goalRuntime: null,
        subagentRuntime: {
          ...runtime,
          finalResults: [
            {
              runId: "run_done",
              roleId: "coding",
              status: "accepted",
              required: true,
              objective: "Clean up insights notification behavior",
              summary: "Suppressed unchanged insight notifications.",
              findings: ["No notification is sent when the insights payload is unchanged."],
              changedFiles: ["apps/server/src/insights/insights-system.ts"],
              refs: [{ kind: "diff", id: "subagent-run:run_done:diff", label: "Insights diff" }],
              testsRun: ["bun test tests/insights-system.test.ts"],
              validationAttempts: ["bun test tests/insights-system.test.ts - passed exit 0"],
              blockers: [],
              confidence: "high",
              packetQualityStatus: "weak",
              packetQualityEvidence: {
                finalSummaryPresent: true,
                finalSummaryLength: 43,
                requestedValidationCommandCount: 1,
                validationAttemptCount: 0,
                failedValidationCount: 0,
                testsRunCount: 1,
                changedFileCount: 1,
                patchRefPresent: false,
                diffRefPresent: true,
                artifactCount: 0,
                findingCount: 1,
                blockerCount: 0,
                unvalidatedWorkspaceChanges: false,
              },
              independentReviewRecommended: true,
              reviewerRoutingReasons: ["high_risk_files"],
              reviewerRoutingEvidence: {
                packetQualityStatus: "reviewable",
                confidence: "high",
                changedFileCount: 1,
                highRiskFileCount: 1,
                validationAttemptCount: 1,
                failedValidationCount: 0,
                missingRequestedValidation: false,
                providerFailureAfterChanges: false,
                userRequestedIndependentReview: false,
              },
              importantMessages: [
                {
                  id: "message_1",
                  runId: "run_done",
                  fromRunId: "run_done",
                  kind: "handoff",
                  body: "Parent review requested.",
                  createdAt: "2026-07-07T10:00:03.000Z",
                },
              ],
              workspaceRetention: {
                status: "retained",
                reason: "Changed child workspace has not been applied; retain for inspection.",
                retainedAt: "2026-07-07T10:00:04.000Z",
                expiresAt: "2026-07-14T10:00:04.000Z",
                retentionDays: 7,
                trigger: "auto_after_acceptance",
                cleanupAfterExpiry: true,
              },
              updatedAt: "2026-07-07T10:00:04.000Z",
            },
          ],
        },
      }),
    );

    expect(html).toContain("Child Results");
    expect(html).toContain("Suppressed unchanged insight notifications.");
    expect(html).toContain("apps/server/src/insights/insights-system.ts");
    expect(html).toContain("bun test tests/insights-system.test.ts");
    expect(html).toContain("diff: Insights diff");
    expect(html).toContain("Weak packet");
    expect(html).toContain("Packet evidence:");
    expect(html).toContain("Independent review recommended");
    expect(html).toContain("Review routing:");
    expect(html).toContain("High Risk Files");
    expect(html).toContain("Workspace: retained until");
    expect(html).toContain("Auto After Acceptance");
    expect(html).toContain("Handoff: Parent review requested.");
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
    submittedRuns: [],
    needsRevisionRuns: [],
    needsUserInputRuns: [],
    acceptedRuns: [],
    failedWithArtifactsRuns: [],
    blockedRuns: [],
    completedRuns: [],
    unresolvedRuns: [codingRun, reviewRun],
    terminalRuns: [],
    archivedRuns: [],
    latestRun: codingRun,
    latestMeaningfulUpdate: {
      runId: "run_coding",
      roleId: "coding",
      status: "running",
      message: "Inspecting files",
      updatedAt: "2026-07-07T10:00:01.000Z",
    },
    watcher: {
      checkedAt: "2026-07-07T10:00:02.000Z",
      activeCount: 2,
      staleCount: 0,
      wakeQueued: false,
      wakePolicy: "not_waking_parent_for_routine_tick",
    },
    activeCount: 2,
    submittedCount: 0,
    needsRevisionCount: 0,
    needsUserInputCount: 0,
    acceptedCount: 0,
    failedWithArtifactsCount: 0,
    blockedCount: 0,
    completedCount: 0,
    unresolvedCount: 2,
    terminalCount: 0,
    archivedCount: 0,
    requiredActiveCount: 2,
    requiredSubmittedForReviewCount: 0,
    requiredNeedsRevisionCount: 0,
    requiredNeedsUserInputCount: 0,
    requiredBlockingCount: 0,
    requiredAcceptedCount: 0,
    requiredTerminalCount: 0,
    requiredArchivedCount: 0,
    requiredUnresolvedCount: 2,
    requiredOpenCount: 2,
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
