import { describe, expect, test } from "vitest";
import { createAgentToolCatalogProjection } from "@openpond/agent-runtime";
import type { RuntimeEvent } from "../packages/contracts/src";
import { createAuthoringModelToolDefinitions } from "../apps/server/src/openpond/authoring-tool-registry";
import { createNativeToolRuntime } from "../apps/server/src/runtime/hosted-turn/native-tools-runtime";
import { baseSession } from "./helpers/byok-turn-runner-harness";

describe("ask_user native runtime", () => {
  test("persists the question, skips sibling calls, and ends the normal tool loop", async () => {
    const events: RuntimeEvent[] = [];
    let siblingExecutions = 0;
    const runtime = createNativeToolRuntime({
      maxRepeatedInvalidToolRequests: 2,
      appendRuntimeEvent: async (event) => {
        events.push(event);
      },
      throwIfInterrupted: () => undefined,
    });
    const definitions = createAuthoringModelToolDefinitions({});
    definitions.push({
      name: "mutation_fixture",
      description: "Test-only mutation fixture.",
      parameters: { type: "object", additionalProperties: false },
      execute: async (context) => {
        siblingExecutions += 1;
        return {
          toolCallId: context.callId,
          name: "mutation_fixture",
          ok: true,
          contentText: "{}",
        };
      },
    });

    const session = baseSession();
    const turnPermissions = {
      approvalPolicy: null,
      sandbox: null,
      codexPermissionMode: null,
      codexReasoningEffort: null,
    };
    const toolCatalog = createAgentToolCatalogProjection(
      definitions.map((definition) => ({
        name: definition.name,
        description: definition.description,
        inputSchema: definition.parameters,
        placement: "local" as const,
        executorAvailable: true,
        execute: (args, context) => definition.execute({
          session,
          turnId: context.turnId,
          turnPermissions,
          provider: "openrouter",
          model: "test/model",
          callId: context.callId,
          args: args as Record<string, unknown>,
          signal: context.signal,
          workspaceDiffBaseline: null,
          mentionedApps: [],
          userPrompt: "Create the Agent.",
          turnMetadata: {},
        }),
      })),
    );
    const results = await runtime.executeNativeToolCalls({
      session,
      turnId: "turn_1",
      turnPermissions,
      provider: "openrouter",
      model: "test/model",
      signal: new AbortController().signal,
      workspaceDiffBaseline: null,
      mentionedApps: [],
      userPrompt: "Create the Agent.",
      turnMetadata: {},
      toolCatalog,
      invalidRequestCounts: new Map(),
      toolCalls: [
        toolCall("call_mutation", "mutation_fixture", {}),
        toolCall("call_question", "ask_user", {
          question: "Should the output be Markdown or JSON?",
          options: [
            { id: "markdown", label: "Markdown" },
            { id: "json", label: "JSON" },
          ],
        }),
      ],
    });

    expect(siblingExecutions).toBe(0);
    expect(results[0]).toMatchObject({
      name: "mutation_fixture",
      ok: false,
      data: { skipped: true, reason: "ask_user_requires_exclusive_batch" },
    });
    expect(results[1]).toMatchObject({
      name: "ask_user",
      ok: true,
      turnControl: "await_user_input",
    });
    const questionEvent = events.find((event) => event.name === "user_question.asked");
    expect(questionEvent).toMatchObject({
      sessionId: "session_1",
      turnId: "turn_1",
      action: "ask_user",
      status: "pending",
    });
    expect((questionEvent?.data as any)?.question).toMatchObject({
      sessionId: "session_1",
      turnId: "turn_1",
      toolCallId: "call_question",
      status: "pending",
    });
    expect(events.some((event) =>
      event.name === "diagnostic" && (event.data as any)?.kind === "thread_goal"
    )).toBe(false);
  });
});

function toolCall(
  id: string,
  name: string,
  args: Record<string, unknown>,
) {
  return {
    id,
    name,
    argumentsJson: JSON.stringify(args),
    hostedToolCall: {
      index: 0,
      id,
      type: "function",
      function: { name, arguments: JSON.stringify(args) },
    },
  };
}
