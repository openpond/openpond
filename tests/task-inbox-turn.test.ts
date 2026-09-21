import { expect, test } from "vitest";
import { createTurnRunnerTestHarness, turnRunnerTestSession } from "./helpers/turn-runner-test-harness";

function gate() { let resolve!: () => void; const promise = new Promise<void>((done) => { resolve = done; }); return { promise, resolve }; }

// Failure story: steering cancels completed/running work, executes stale proposed actions, or loses the original assignment.
test("steering replaces only a provider request and preserves an admitted tool in the same turn", async () => {
  const generating = gate(), toolStarted = gate(), releaseTool = gate();
  const executed: string[] = [];
  const requests: string[] = [];
  let pass = 0;
  let toolSignal: AbortSignal | undefined;
  const harness = createTurnRunnerTestHarness({
    sessions: [turnRunnerTestSession({ experience: "development" })],
    dependencies: {
      maxHostedWorkspaceToolRounds: 6,
      harnessModelTools: [{ name: "boundary_tool", description: "Boundary tool", parameters: { type: "object", properties: {}, additionalProperties: false },
        execute: async (context) => {
          executed.push(context.callId); toolSignal = context.signal; toolStarted.resolve(); await releaseTool.promise;
          return { toolCallId: context.callId, name: "boundary_tool", ok: true, contentText: "durable tool result", data: {} };
        },
      }],
      streamLocalByokChatTurn: async function* (input) {
        pass++;
        requests.push(JSON.stringify(input.messages));
        if (pass === 1) {
          yield { text: "Partial plan", toolCalls: [{ id: "incomplete", type: "function", function: { name: "boundary_tool", arguments: '{"unfinished":' } }] };
          generating.resolve();
          await new Promise<void>((_, reject) => {
            if (input.signal.aborted) reject(input.signal.reason);
            else input.signal.addEventListener("abort", () => reject(input.signal.reason), { once: true });
          });
        } else if (pass === 2) {
          yield { toolCalls: ["admitted", "stale-proposal"].map((id) => ({ id, type: "function", function: { name: "boundary_tool", arguments: "{}" } })) };
        } else yield { text: "Finished the original assignment with both corrections." };
      },
    },
  });
  const turnPromise = harness.runner.sendTurn("session_test", { prompt: "Compare the approaches and deliver the chosen implementation.", modelRef: { providerId: "openrouter", modelId: "test/model" } });
  await generating.promise;
  const turnId = harness.state.turns[0]!.id;
  await harness.runner.steerSessionTurn("session_test", { prompt: "Preserve the public API.", expectedTurnId: turnId, idempotencyKey: "first" });
  await toolStarted.promise;
  await harness.runner.steerSessionTurn("session_test", { prompt: "Use the existing data format.", expectedTurnId: turnId, idempotencyKey: "second" });
  expect(toolSignal?.aborted).toBe(false);
  releaseTool.resolve();
  expect(await turnPromise).toMatchObject({ id: turnId, status: "completed" });
  expect(harness.state.turns).toHaveLength(1);
  expect(executed).toEqual(["admitted"]);
  expect(requests[2]).toContain("Compare the approaches and deliver the chosen implementation.");
  expect(requests[2]).toContain("Preserve the public API.");
  expect(requests[2]).toContain("Use the existing data format.");
  expect(requests[2]).toContain("durable tool result");
  expect(requests[2]).toContain("pending_user_steer");
  expect((await harness.runner.readTaskInbox("session_test")).inputs.map((input) => input.state)).toEqual(["resolved", "resolved"]);
  await harness.runner.close();
});
