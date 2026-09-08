import { describe, expect, it } from "vitest";

import { createHarnessSourceRuntime, executeHarnessRollout } from "../src/index.js";
import { sourceRuntimeFixture } from "./source-runtime-fixture.js";

describe("shared Harness rollout lifecycle", () => {
  it("terminates a source-only loop at its budget and keeps private reads out of environment effects", async () => {
    const source = sourceRuntimeFixture();
    const runtime = createHarnessSourceRuntime({ sourcePackage: source,
      expectedRelease: { id: source.harnessRelease.id, contentHash: source.harnessRelease.contentHash },
      runtimeId: "test", baseSystemPrompt: "Format the label.", tools: [], maxContextCharacters: 50_000 });
    let terminated = 0;
    const result = await executeHarnessRollout({
      turnId: "source-only", maxTurns: 2, signal: new AbortController().signal,
      runtime, systemPrompt: "unused", userPrompt: "Read a resource.", tools: [],
      async policyRequest(request) {
        // A transport mutation must not alter the runtime's retained instructions.
        request.messages[0]!.content = "transport mutation";
        return { result: request.turnIndex, content: null, toolCalls: [{ id: `read-${request.turnIndex}`,
          name: "harness_read_file", arguments: JSON.stringify({ path: "private/grader.txt" }) }] };
      },
      async step() { throw new Error("Source reads must not step the environment."); },
      async terminate(reason) { expect(reason).toBe("max_turns"); terminated += 1; return { toolResults: [], userMessage: null, terminal: true }; },
    });
    expect(terminated).toBe(1);
    expect(result.policyResults).toEqual([0, 1]);
    expect(result.messages[0]!.content).toBe(runtime.systemPrompt);
    expect(JSON.stringify(result.messages)).not.toContain("PRIVATE_GRADER_SOURCE_NOT_POLICY_CONTEXT");
    expect(result.messages.filter(message => message.role === "tool")).toHaveLength(2);
    expect(result.trace.at(-1)).toMatchObject({ terminationReason: "max_turns" });
  });

  it("does not execute environment effects after cancellation during a model request", async () => {
    const controller = new AbortController();
    let environmentEffects = 0;
    await expect(executeHarnessRollout({
      turnId: "cancel", maxTurns: 2, signal: controller.signal,
      runtime: null, systemPrompt: "Task policy", userPrompt: "Task", tools: [],
      async policyRequest() { controller.abort(new Error("cancelled")); return { result: null, content: "done", toolCalls: [] }; },
      async step() { environmentEffects += 1; return { toolResults: [], userMessage: null, terminal: true }; },
      async terminate() { environmentEffects += 1; return { toolResults: [], userMessage: null, terminal: true }; },
    })).rejects.toThrow("cancelled");
    expect(environmentEffects).toBe(0);
  });
});
