import path from "node:path";

import { describe, expect, test } from "vitest";

import { localProjectActionCatalog } from "../apps/server/src/project-actions/local-project-actions";
import { createProjectActionRunPayload } from "../apps/server/src/project-actions/project-action-payload";
import { createByokTurnRunnerHarness } from "./helpers/byok-turn-runner-harness";

const projectRoot = path.resolve(import.meta.dirname, "../examples/project-actions-analytics");

describe("local Project Actions through a Work conversation", () => {
  test("selects the action on the first turn and retains its result for a follow-up", async () => {
    const catalog = await localProjectActionCatalog({
      id: "local_project_analytics",
      workspacePath: projectRoot,
    });
    const actionRuns: unknown[] = [];
    let executeProjectAction: (payload: unknown) => Promise<unknown> = async () => {
      throw new Error("Project Action executor was not initialized");
    };
    const harness = createByokTurnRunnerHarness({
      sessionOverrides: {
        workspaceKind: "local_project",
        workspaceId: "local_project_analytics",
        localProjectId: "local_project_analytics",
        cwd: projectRoot,
      },
      toolCallsByPass: {
        1: [{
          name: "openpond_action_run",
          args: {
            actionId: "analytics.get_summary",
            input: { businessId: "relocation" },
          },
        }],
      },
      finalText: "Relocation has 42 active moves and $128,500 in booked revenue.",
      executeProjectAction: async (payload) => {
        actionRuns.push(payload);
        return executeProjectAction(payload);
      },
    });
    executeProjectAction = createProjectActionRunPayload({
      appendRuntimeEvent: async (event) => {
        harness.events.push(event);
      },
      resolveProjectRoot: async (projectId) =>
        projectId === "local_project_analytics" ? projectRoot : null,
    });

    const first = await harness.runner.sendTurn("session_1", {
      prompt: "Show me the current relocation analytics.",
      modelRef: { providerId: "openrouter", modelId: "test/model" },
      openPondActionCatalog: catalog,
    });
    const second = await harness.runner.sendTurn("session_1", {
      prompt: "How many active moves was that?",
      modelRef: { providerId: "openrouter", modelId: "test/model" },
      openPondActionCatalog: catalog,
    });

    expect(first.status).toBe("completed");
    expect(second.status).toBe("completed");
    expect(actionRuns).toHaveLength(1);
    expect(harness.streamInputs).toHaveLength(3);
    expect(harness.streamInputs[1].messages).toContainEqual(expect.objectContaining({
      role: "tool",
      tool_call_id: "call_test_tool_1_0",
      content: expect.stringContaining('"activeMoves": 42'),
    }));
    expect(harness.streamInputs[2].messages).toContainEqual({
      role: "assistant",
      content: "Relocation has 42 active moves and $128,500 in booked revenue.",
    });
    expect(harness.streamInputs[2].messages).toContainEqual({
      role: "user",
      content: "How many active moves was that?",
    });
    expect(harness.events.filter((event) => event.name === "tool.started" && event.action === "openpond_action_run")).toHaveLength(1);
  });
});
