import { describe, expect, test } from "vitest";
import type {
  WorkspaceToolRequest,
  WorkspaceToolResult,
} from "@openpond/contracts";
import { createByokTurnRunnerHarness } from "./helpers/byok-turn-runner-harness";

const PROVIDER_PATHS = [
  { providerId: "openrouter", modelId: "test/openai-compatible" },
  { providerId: "openpond", modelId: "openpond-chat" },
  { providerId: "local-adapter", modelId: "test/local-tool-model" },
] as const;

describe.each(PROVIDER_PATHS)(
  "Work unchanged-loop qualification: $providerId",
  ({ providerId, modelId }) => {
    test("answers directly without provisioning compute", async () => {
      const harness = createByokTurnRunnerHarness({
        providerId,
        modelId,
        toolArgs: null,
        finalText: "The supplied information is sufficient.",
        sessionOverrides: { experience: "work" },
      });

      const turn = await harness.runner.sendTurn("session_1", {
        prompt: "Explain the supplied information.",
        modelRef: { providerId, modelId },
      });

      expect(turn.status).toBe("completed");
      expect(harness.streamInputs).toHaveLength(1);
      expect(harness.streamInputs[0].tools).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            function: expect.objectContaining({ name: "work_environment" }),
          }),
        ])
      );
    });

    test("creates and reviews a Markdown result through multiple tool rounds", async () => {
      const calls: WorkspaceToolRequest[] = [];
      const harness = createByokTurnRunnerHarness({
        providerId,
        modelId,
        sessionOverrides: { experience: "work" },
        maxHostedWorkspaceToolRounds: 4,
        toolCallsByPass: {
          1: [
            {
              name: "work_write_file",
              args: {
                area: "outputs",
                path: "summary.md",
                content: "# Summary\n\nQualified.\n",
              },
            },
          ],
          2: [
            {
              name: "work_read_file",
              args: {
                area: "outputs",
                path: "summary.md",
              },
            },
          ],
        },
        finalText: "Created and reviewed summary.md.",
        executeWorkspaceTool: async (_sessionId, payload) => {
          const request = payload as WorkspaceToolRequest;
          calls.push(request);
          return {
            ok: true,
            action: request.action,
            output: "ok",
            data:
              request.action === "sandbox_status"
                ? {
                    sandbox: {
                      id: "sandbox_qualified",
                      state: "running",
                    },
                  }
                : {},
          } satisfies WorkspaceToolResult;
        },
      });

      const turn = await harness.runner.sendTurn("session_1", {
        prompt: "Create and save a Markdown summary.",
        modelRef: { providerId, modelId },
      });

      expect(turn.status).toBe("completed");
      expect(harness.streamInputs).toHaveLength(3);
      expect(
        harness.streamInputs[0].tools.map(
          (tool: { function: { name: string } }) => tool.function.name
        )
      ).not.toContain("work_save_output");
      expect(calls.map((call) => call.action)).toEqual([
        "sandbox_create",
        "sandbox_status",
        "sandbox_write_file",
        "sandbox_read_file",
      ]);
    });

    test("receives a bounded tool error and continues to a final answer", async () => {
      const calls: WorkspaceToolRequest[] = [];
      const harness = createByokTurnRunnerHarness({
        providerId,
        modelId,
        sessionOverrides: { experience: "work" },
        toolCallsByPass: {
          1: [
            {
              name: "work_read_file",
              args: { area: "work", path: "../outside.txt" },
            },
          ],
        },
        finalText:
          "The requested path was outside Work, so I stopped using it and continued safely.",
        executeWorkspaceTool: async (_sessionId, payload) => {
          const request = payload as WorkspaceToolRequest;
          calls.push(request);
          return {
            ok: true,
            action: request.action,
            output: "ok",
            data: {},
          } satisfies WorkspaceToolResult;
        },
      });

      const turn = await harness.runner.sendTurn("session_1", {
        prompt:
          "Inspect the draft, recover safely from path errors, and report.",
        modelRef: { providerId, modelId },
      });

      expect(turn.status).toBe("completed");
      expect(harness.streamInputs).toHaveLength(2);
      expect(calls).toEqual([]);
      expect(
        harness.events.some(
          (event) =>
            event.name === "tool.completed" &&
            event.output?.includes("escaped its selected area")
        )
      ).toBe(true);
    });
  }
);
