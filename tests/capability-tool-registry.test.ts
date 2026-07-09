import { describe, expect, test } from "bun:test";
import { createOpenPondCapabilityModelToolDefinitions } from "../apps/server/src/openpond/capability-tool-registry";
import type {
  ModelToolExecutionContext,
  ModelToolDefinition,
} from "../apps/server/src/openpond/model-tool-registry";
import type { Session } from "../packages/contracts/src";

describe("OpenPond capability tool registry", () => {
  test("adds subagent tools only when subagent handlers are supplied", () => {
    const withoutSubagents = createOpenPondCapabilityModelToolDefinitions(requiredHandlers());
    expect(withoutSubagents.map((definition) => definition.name)).not.toContain("openpond_subagent_start");

    const withSubagents = createOpenPondCapabilityModelToolDefinitions({
      ...requiredHandlers(),
      startSubagent: async () => subagentToolResult("queued"),
      statusSubagents: async () => ({ runs: [], nextStep: "No runs." }),
      joinSubagent: async () => subagentToolResult("completed"),
      cancelSubagent: async () => subagentToolResult("cancelled"),
      sendSubagentMessage: async () => subagentMessageToolResult(),
    });

    expect(withSubagents.map((definition) => definition.name)).toEqual([
      "openpond_create_pipeline",
      "openpond_goal_control",
      "openpond_subagent_start",
      "openpond_subagent_status",
      "openpond_subagent_join",
      "openpond_subagent_cancel",
      "openpond_subagent_send_message",
    ]);
  });

  test("maps subagent tool inputs and returns structured native tool results", async () => {
    const calls: unknown[] = [];
    const definitions = createOpenPondCapabilityModelToolDefinitions({
      ...requiredHandlers(),
      startSubagent: async (_context, input) => {
        calls.push({ tool: "start", input });
        return subagentToolResult("queued");
      },
      statusSubagents: async (_context, input) => {
        calls.push({ tool: "status", input });
        return { runs: [subagentToolResult("queued")], nextStep: "Loaded 1 run." };
      },
      joinSubagent: async (_context, input) => {
        calls.push({ tool: "join", input });
        return subagentToolResult("completed");
      },
      cancelSubagent: async (_context, input) => {
        calls.push({ tool: "cancel", input });
        return subagentToolResult("cancelled");
      },
      reviewSubagent: async (_context, input) => {
        calls.push({ tool: "review", input });
        return subagentToolResult("completed");
      },
      sendSubagentMessage: async (_context, input) => {
        calls.push({ tool: "message", input });
        return subagentMessageToolResult();
      },
    });

    const start = requireTool(definitions, "openpond_subagent_start");
    const status = requireTool(definitions, "openpond_subagent_status");
    const join = requireTool(definitions, "openpond_subagent_join");
    const cancel = requireTool(definitions, "openpond_subagent_cancel");
    const review = requireTool(definitions, "openpond_subagent_review");
    const message = requireTool(definitions, "openpond_subagent_send_message");

    const startResult = await start.execute(context({
      roleId: "coding",
      objective: "Fix the failing tests",
      context: "Use the current branch diff.",
      workerBrief: {
        plan: ["Inspect failing tests", "Patch the implementation"],
        targetFiles: ["tests/failing.test.ts"],
        acceptanceCriteria: ["Focused tests pass"],
        validationCommands: ["bun test tests/failing.test.ts"],
        stopConditions: ["Report a blocker if dependencies are missing"],
      },
      required: false,
    }));
    const statusResult = await status.execute(context({ parentGoalId: "goal_1" }));
    const joinResult = await join.execute(context({ runId: "run_1" }));
    const cancelResult = await cancel.execute(context({
      runId: "run_1",
      reason: "No longer needed.",
      cleanupWorkspace: false,
    }));
    const reviewResult = await review.execute(context({
      runId: "run_1",
      decision: "dismiss",
      summary: "Acknowledged blocked child work.",
      issues: ["Child is blocked on unavailable external approval."],
    }));
    const messageResult = await message.execute(context({
      toRole: "review",
      kind: "handoff",
      priority: "interrupt",
      body: "Please review the patch.",
    }));

    expect(calls).toEqual([
      {
        tool: "start",
        input: {
          roleId: "coding",
          objective: "Fix the failing tests",
          context: "Use the current branch diff.",
          workerBrief: {
            plan: ["Inspect failing tests", "Patch the implementation"],
            targetFiles: ["tests/failing.test.ts"],
            acceptanceCriteria: ["Focused tests pass"],
            validationCommands: ["bun test tests/failing.test.ts"],
            stopConditions: ["Report a blocker if dependencies are missing"],
          },
          required: false,
        },
      },
      { tool: "status", input: { parentGoalId: "goal_1" } },
      { tool: "join", input: { runId: "run_1" } },
      {
        tool: "cancel",
        input: {
          runId: "run_1",
          reason: "No longer needed.",
          cleanupWorkspace: false,
        },
      },
      {
        tool: "review",
        input: {
          runId: "run_1",
          decision: "dismiss",
          summary: "Acknowledged blocked child work.",
          issues: ["Child is blocked on unavailable external approval."],
          requiredCorrections: null,
          messageChild: null,
          priority: null,
        },
      },
      {
        tool: "message",
        input: {
          toRunId: null,
          toRole: "review",
          kind: "handoff",
          priority: "interrupt",
          body: "Please review the patch.",
        },
      },
    ]);
    expect(startResult).toMatchObject({
      toolCallId: "call_1",
      name: "openpond_subagent_start",
      ok: true,
      data: { runId: "run_1", roleId: "coding", status: "queued" },
    });
    expect(statusResult).toMatchObject({
      name: "openpond_subagent_status",
      data: { nextStep: "Loaded 1 run." },
    });
    expect(joinResult).toMatchObject({
      name: "openpond_subagent_join",
      data: { status: "completed" },
    });
    expect(cancelResult).toMatchObject({
      name: "openpond_subagent_cancel",
      data: { status: "cancelled" },
    });
    expect(reviewResult).toMatchObject({
      name: "openpond_subagent_review",
      data: { status: "completed" },
    });
    expect(messageResult).toMatchObject({
      name: "openpond_subagent_send_message",
      data: {
        messageId: "message_1",
        delivery: {
          status: "delivered",
          deliveredRunIds: ["run_1"],
          acknowledgedRunIds: ["run_1"],
        },
      },
    });
  });

  test("rejects invalid subagent mailbox kinds before handler execution", async () => {
    const definitions = createOpenPondCapabilityModelToolDefinitions({
      ...requiredHandlers(),
      sendSubagentMessage: async () => subagentMessageToolResult(),
    });

    await expect(
      requireTool(definitions, "openpond_subagent_send_message").execute(context({
        kind: "note",
        body: "invalid",
      })),
    ).rejects.toThrow("kind must be question, answer, handoff, artifact, status, or blocker");
  });

  test("rejects invalid subagent mailbox priority before handler execution", async () => {
    const definitions = createOpenPondCapabilityModelToolDefinitions({
      ...requiredHandlers(),
      sendSubagentMessage: async () => subagentMessageToolResult(),
    });

    await expect(
      requireTool(definitions, "openpond_subagent_send_message").execute(context({
        kind: "status",
        priority: "urgent",
        body: "invalid",
      })),
    ).rejects.toThrow("priority must be normal or interrupt");
  });
});

function requiredHandlers() {
  return {
    startCreatePipeline: async () => ({
      requestId: "request_1",
      pipelineId: "pipeline_1",
      operation: "create" as const,
      state: "planning" as const,
      nextStep: "Started.",
    }),
    startGoalControl: async () => ({
      goalId: "goal_1",
      action: "start" as const,
      status: "active",
      objective: "Ship subagents",
      mode: "local" as const,
      nextStep: "Goal started.",
    }),
  };
}

function subagentToolResult(status: "queued" | "completed" | "cancelled") {
  return {
    runId: "run_1",
    childSessionId: "session_child",
    roleId: "coding",
    status,
    modelRef: { providerId: "zai", modelId: "glm-5.2" },
    isolationMode: "copy_on_write" as const,
    toolPolicy: "workspace_write" as const,
    background: true,
    peerMessages: "goal_scoped" as const,
    nextStep: status === "completed" ? "Completed." : "Queued.",
  };
}

function subagentMessageToolResult() {
  return {
    messageId: "message_1",
    delivery: {
      status: "delivered" as const,
      deliveredRunIds: ["run_1"],
      acknowledgedRunIds: ["run_1"],
      reason: null,
    },
    nextStep: "Message persisted.",
  };
}

function requireTool(definitions: ModelToolDefinition[], name: string): ModelToolDefinition {
  const definition = definitions.find((candidate) => candidate.name === name);
  if (!definition) throw new Error(`${name} missing`);
  return definition;
}

function context(args: Record<string, unknown>): ModelToolExecutionContext {
  return {
    session: baseSession(),
    turnId: "turn_1",
    provider: "openrouter",
    model: "test/model",
    callId: "call_1",
    args,
    signal: new AbortController().signal,
    workspaceDiffBaseline: null,
    mentionedApps: [],
    userPrompt: "Use subagents.",
  };
}

function baseSession(): Session {
  return {
    id: "session_1",
    provider: "openrouter",
    modelRef: { providerId: "openrouter", modelId: "test/model" },
    openPondCommandAccessMode: "ask",
    title: "BYOK chat",
    appId: null,
    appName: null,
    workspaceKind: undefined,
    workspaceId: null,
    workspaceName: null,
    localProjectId: null,
    cloudProjectId: null,
    cloudTeamId: null,
    cwd: null,
    codexThreadId: null,
    createdAt: "2026-07-07T10:00:00.000Z",
    updatedAt: "2026-07-07T10:00:00.000Z",
    status: "idle",
    pinned: false,
    archived: false,
    order: 0,
  };
}
