import { describe, expect, test } from "bun:test";
import type {
  CreatePipelineRequest,
  CreatePipelineSnapshot,
  RuntimeEvent,
} from "@openpond/contracts";
import { detectCreateEditInsights } from "../apps/server/src/insights/create-edit-insights";

const timestamp = "2026-07-01T10:00:00.000Z";

describe("create/edit insights detector", () => {
  test("creates active insights for waiting and blocked create/edit pipelines", () => {
    const createWaiting = createPipelineSnapshot("create_pipeline_waiting", "create", "awaiting_plan_approval");
    const editBlocked = createPipelineSnapshot("create_pipeline_blocked", "edit", "blocked");
    const candidates = detectCreateEditInsights(
      [
        eventEntry(1, createWaiting),
        eventEntry(2, editBlocked),
      ],
      timestamp,
    );

    expect(candidates.map((candidate) => candidate.item?.type)).toEqual([
      "create_edit.awaiting_plan_approval",
      "create_edit.blocked",
    ]);
    expect(candidates[0]?.item).toMatchObject({
      severity: "concern",
      status: "active",
      title: "Create agent is waiting for plan approval",
      payload: {
        createPipelineId: "create_pipeline_waiting",
        createPipelineOperation: "create",
        sourceEventSequence: 1,
      },
    });
    expect(candidates[1]?.item).toMatchObject({
      severity: "blocker",
      title: "Edit agent is blocked",
      payload: {
        createPipelineId: "create_pipeline_blocked",
        createPipelineOperation: "edit",
      },
    });
  });

  test("returns a resolve candidate when the latest pipeline state no longer needs attention", () => {
    const ready = createPipelineSnapshot("create_pipeline_ready", "create", "ready_local");
    const candidates = detectCreateEditInsights([eventEntry(3, ready)], timestamp);

    expect(candidates).toEqual([
      {
        createPipelineId: "create_pipeline_ready",
        keepFingerprint: null,
        item: null,
      },
    ]);
  });

  test("ignores non-create-edit pipeline operations", () => {
    const imported = createPipelineSnapshot("create_pipeline_import", "import", "blocked");
    expect(detectCreateEditInsights([eventEntry(4, imported)], timestamp)).toEqual([]);
  });

  test("keeps blocked summaries short", () => {
    const blocked = {
      ...createPipelineSnapshot("create_pipeline_long", "create", "blocked"),
      blockedReason: "failure ".repeat(200),
    };
    const [candidate] = detectCreateEditInsights([eventEntry(5, blocked)], timestamp);
    expect(candidate?.item?.summary.length).toBeLessThanOrEqual(360);
    expect(candidate?.item?.summary.endsWith("...")).toBe(true);
  });
});

function eventEntry(
  sequence: number,
  snapshot: CreatePipelineSnapshot,
): { sequence: number; event: RuntimeEvent } {
  return {
    sequence,
    event: {
      id: `event_${sequence}`,
      sequence,
      sessionId: "session_1",
      turnId: "turn_1",
      name: "create_pipeline.updated",
      timestamp,
      source: "server",
      status: "pending",
      data: {
        createPipelineRequest: snapshot.request,
        createPipeline: snapshot,
      },
    },
  };
}

function createPipelineSnapshot(
  id: string,
  operation: CreatePipelineRequest["operation"],
  state: CreatePipelineSnapshot["state"],
): CreatePipelineSnapshot {
  const request = createPipelineRequest(`${id}_request`, operation);
  return {
    schemaVersion: "openpond.createPipeline.snapshot.v1",
    id,
    goalId: `${id}_goal`,
    state,
    request,
    plan: {
      schemaVersion: "openpond.createPipeline.plan.v1",
      id: `${id}_plan`,
      goalId: `${id}_goal`,
      requestId: request.id,
      status: "pending_approval",
      objective: request.objective,
      summary: "Build the requested agent.",
      capturedContextSummary: "User asked for an agent.",
      defaultChatAction: { key: "chat", label: "Chat", required: true },
      sourcePlan: [],
      requirements: [],
      checks: [],
      approvalId: `${id}_approval`,
      approvedAt: null,
      editedFromPlanId: null,
      metadata: {},
      createdAt: timestamp,
      updatedAt: timestamp,
    },
    workflowCapture: null,
    approvalIds: [`${id}_approval`],
    questionIds: [],
    questions: [],
    checkRefs: [],
    sourceRefs: [],
    localGoalId: null,
    localProfileCommit: null,
    hostedGoalId: null,
    hostedSourceCommit: null,
    hostedSourceRef: null,
    blockedReason: state === "blocked" ? "Source application failed." : null,
    metadata: {},
    createdAt: timestamp,
    updatedAt: timestamp,
  };
}

function createPipelineRequest(
  id: string,
  operation: CreatePipelineRequest["operation"],
): CreatePipelineRequest {
  return {
    schemaVersion: "openpond.createPipeline.request.v1",
    id,
    operation,
    surface: operation === "edit" ? "direct_prompt_edit" : "direct_prompt_create",
    command: operation === "edit" ? "/edit" : "/create",
    objective: operation === "edit" ? "Refine an agent" : "Create an agent",
    adapter: {
      kind: "local",
      sourceAuthority: "local_profile",
      activeProfile: "default",
      repoPath: "/tmp/openpond-profile",
      sourcePath: "/tmp/openpond-profile/agents",
      localHead: null,
      confirmationPolicy: "always_require_plan_approval",
    },
    actor: { id: null, kind: "user", label: null },
    scope: {
      conversationId: "session_1",
      workItemId: null,
      projectId: null,
      targetProject: null,
    },
    context: {
      messageIds: [],
      conversationExcerpts: [],
      attachments: [],
      apps: [],
      tools: [],
      targetRepoAssumptions: [],
    },
    targetAgent: {
      agentId: null,
      displayName: null,
      defaultActionKey: "chat",
    },
    metadata: {},
    createdAt: timestamp,
  };
}
