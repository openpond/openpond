import { describe, expect, test } from "vitest";

import {
  action,
  defineAgentProject,
  defineIntent,
  defineIntentRouter,
  defineSkill,
  defineWorkflow,
} from "openpond-agent-sdk/primitives";
import { createRunState, executeAction } from "openpond-agent-sdk/runtime";

const answerWorkflow = defineWorkflow({
  name: "answer-workflow",
  async run(ctx, input) {
    await ctx.loadSkill("answer-policy");
    ctx.trace.artifact("artifacts/answer.json", { token: "do-not-store" });
    const prompt = await ctx.step("normalize-prompt", async () => String(input.prompt ?? "").trim());
    const toolResult = await ctx.tool("lookup-context", async () => ({ prompt }));
    const text = await ctx.model("format-answer", async () => `Answer: ${toolResult.prompt}`);
    const metadata = await ctx.action("post-process", async () => ({ normalized: prompt }));
    return {
      text,
      intent: "answer",
      artifactRefs: ["artifacts/answer.json"],
      metadata,
    };
  },
});

const failWorkflow = defineWorkflow({
  name: "fail-workflow",
  async run() {
    throw new Error("boom");
  },
});

const slowWorkflow = defineWorkflow({
  name: "slow-workflow",
  async run() {
    await new Promise((resolve) => setTimeout(resolve, 50));
    return { text: "slow", intent: "slow" };
  },
});

const commandWorkflow = defineWorkflow({
  name: "command-workflow",
  async run(ctx) {
    const result = await ctx.runCommand("printf 'command output'");
    return {
      text: result.stdout ?? "",
      intent: result.status,
    };
  },
});

const answerIntent = defineIntent({
  name: "answer",
  description: "Answer a prompt.",
  async run(ctx, input) {
    return ctx.workflow("answer-workflow", input);
  },
});

const clarifyIntent = defineIntent({
  name: "clarify",
  description: "Ask for missing input.",
  when: (input) => input.prompt.trim().length === 0,
  async run() {
    return { text: "What should I answer?", intent: "clarify", needsUserInput: true };
  },
});

const chatRouter = defineIntentRouter({
  intents: [clarifyIntent, answerIntent],
  defaultIntent: answerIntent,
  routing: { strategy: "code", traceSelection: true },
});

const project = defineAgentProject({
  name: "runtime-harness-agent",
  version: "0.1.0",
  useCase: "runtime-harness",
  manifestMode: "typescript",
  runtime: { base: "node-bun-workspace" },
  skills: [
    defineSkill({
      name: "answer-policy",
      description: "Use when answering.",
      markdown: "Answer directly.",
    }),
  ],
  defaultAction: "chat",
  actions: [
    action("chat", { target: { kind: "intent-router", router: chatRouter } }),
    action("direct", { target: { kind: "workflow", workflow: answerWorkflow } }),
    action("fail", { target: { kind: "workflow", workflow: failWorkflow } }),
    action("slow", { target: { kind: "workflow", workflow: slowWorkflow } }),
    action("command", { target: { kind: "workflow", workflow: commandWorkflow } }),
  ],
  workflows: [answerWorkflow, failWorkflow, slowWorkflow, commandWorkflow],
});

describe("runtime harness contract", () => {
  test("executes intent routers, workflows, spans, skills, artifacts, and channel-neutral results", async () => {
    const state = createRunState();
    const result = await executeAction(
      project,
      "chat",
      { prompt: "hello", channel: "openpond_chat" },
      state,
    );

    expect(result).toMatchObject({
      text: "Answer: hello",
      intent: "answer",
      artifactRefs: ["artifacts/answer.json"],
      metadata: { normalized: "hello" },
    });
    expect(state.artifacts).toEqual([
      { ref: "artifacts/answer.json", metadata: { token: "[redacted]" } },
    ]);
    expect(eventNames(state)).toEqual(expect.arrayContaining([
      "action.started",
      "intent.router.started",
      "intent.selected",
      "workflow.started",
      "skill.loaded",
      "artifact.created",
      "step.completed",
      "tool.completed",
      "model.completed",
      "action.completed",
      "workflow.completed",
      "intent.completed",
    ]));
  });

  test("executes direct workflow actions through the same harness", async () => {
    const state = createRunState();
    const result = await executeAction(
      project,
      "direct",
      { prompt: "direct", channel: "api" },
      state,
    );

    expect(result).toMatchObject({ text: "Answer: direct", intent: "answer" });
    expect(eventNames(state)).toContain("workflow.completed");
  });

  test("executes workflow commands and captures their output", async () => {
    const state = createRunState();
    const result = await executeAction(
      project,
      "command",
      { prompt: "", channel: "api" },
      state,
    );

    expect(result).toMatchObject({
      text: "command output",
      intent: "succeeded",
    });
    expect(state.events).toContainEqual(
      expect.objectContaining({
        name: "command.completed",
        payload: expect.objectContaining({ status: "succeeded", exitCode: 0 }),
      }),
    );
  });

  test("records failure events for failing workflows", async () => {
    const state = createRunState();
    await expect(executeAction(
      project,
      "fail",
      { prompt: "fail", channel: "api" },
      state,
    )).rejects.toThrow("boom");

    expect(eventNames(state)).toEqual(expect.arrayContaining([
      "workflow.failed",
      "action.failed",
    ]));
  });

  test("supports action timeout guards", async () => {
    const state = createRunState();
    await expect(executeAction(
      project,
      "slow",
      { prompt: "slow", channel: "api" },
      state,
      { timeoutMs: 1 },
    )).rejects.toThrow("Action slow timed out after 1ms.");

    expect(eventNames(state)).toContain("action.failed");
  });

  test("supports action cancellation guards", async () => {
    const state = createRunState();
    const controller = new AbortController();
    controller.abort();

    await expect(executeAction(
      project,
      "chat",
      { prompt: "hello", channel: "api" },
      state,
      { signal: controller.signal },
    )).rejects.toThrow("Action was canceled.");

    expect(eventNames(state)).toContain("action.failed");
  });
});

function eventNames(state: ReturnType<typeof createRunState>) {
  return state.events.map((event) => event.name);
}
