import { describe, expect, test } from "bun:test";
import {
  CROSS_SYSTEM_BOOTSTRAP_SYSTEM_PROMPT,
  CROSS_SYSTEM_LOCAL_TOOL_SYSTEM_PROMPT,
  CROSS_SYSTEM_TOOL_CONTRACT_HASH,
  CROSS_SYSTEM_TOOL_DEFINITIONS,
  CROSS_SYSTEM_TOOL_NAMES,
} from "@openpond/contracts";
import type { HostedChatMessage, HostedChatTool } from "@openpond/cloud";
import { localAdapterInferenceRequest, localAdapterWorkerEnv } from "../apps/server/src/training/local-adapter-chat-runtime";
import { supportsCrossSystemToolCalling } from "../apps/server/src/training/local-adapter-models";
import {
  assertLocalAdapterToolBudget,
  crossSystemToolsFromRequest,
  LOCAL_ADAPTER_MAX_TOOL_TURNS,
  LocalAdapterToolProtocolError,
  parseLocalAdapterOutput,
  serializeLocalAdapterMessages,
} from "../apps/server/src/training/local-adapter-tool-protocol";
import { nativeToolTransportEnabledForProvider, resolveHostedToolRolloutFlags } from "../apps/server/src/runtime/hosted-turn/rollout";
import { createOpenPondActionModelToolDefinitions } from "../apps/server/src/openpond/model-tool-registry";
import { createCrossSystemChatToolRuntime, generateCrossSystemTasks, generateCrossSystemWorld, PersistentPythonSandbox } from "../apps/server/src/training/cross-system-operations";
import { tasksetFixture } from "./helpers/training-fixtures";

const tools: HostedChatTool[] = CROSS_SYSTEM_TOOL_DEFINITIONS.map((definition) => ({ type: "function", function: { name: definition.name, description: definition.description, parameters: structuredClone(definition.parameters) as Record<string, unknown> } }));

describe("local adapter constrained tool protocol", () => {
  test("accepts one registered schema-valid call and rejects unknown, malformed, and invalid calls", () => {
    const selected = crossSystemToolsFromRequest([...tools, { type: "function", function: { name: "production_lookup", parameters: { type: "object" } } }]);
    expect(selected.map((tool) => tool.function?.name)).toEqual(CROSS_SYSTEM_TOOL_NAMES);
    expect(parseLocalAdapterOutput(JSON.stringify({ type: "tool_call", id: "call_1", name: "search_crm", arguments: { query: "Atlas", fields: ["account_id"], cursor: null, limit: 10 } }), selected)).toMatchObject({ type: "tool_call", toolCall: { id: "call_1", function: { name: "search_crm" } } });
    expect(() => parseLocalAdapterOutput(JSON.stringify({ type: "tool_call", name: "production_lookup", arguments: {} }), selected)).toThrow(LocalAdapterToolProtocolError);
    expect(() => parseLocalAdapterOutput('{"type":"tool_call",', selected)).toThrow("malformed tool-call JSON");
    expect(() => parseLocalAdapterOutput(JSON.stringify({ type: "tool_call", name: "search_crm", arguments: { query: "", fields: [], cursor: null, limit: 500 } }), selected)).toThrow("too short");
  });

  test("requires one ANSWER JSON object and constrains trailing generated tokens", () => {
    expect(parseLocalAdapterOutput('ANSWER: {"matches":[]})', tools)).toEqual({
      type: "final",
      content: 'ANSWER: {"matches":[]}',
    });
    expect(parseLocalAdapterOutput(JSON.stringify({ type: "final", content: "ANSWER:{\"matches\":[]}" }), tools)).toEqual({
      type: "final",
      content: 'ANSWER: {"matches":[]}',
    });
    expect(() => parseLocalAdapterOutput('ANSWER: {"matches":', tools)).toThrow("malformed ANSWER JSON");
    expect(() => parseLocalAdapterOutput("Done.", tools)).toThrow("must use ANSWER");
    expect(() => parseLocalAdapterOutput('{"matches":[]}', tools)).toThrow("must use ANSWER");
  });

  test("preserves typed assistant calls and tool results in the next model generation", () => {
    const messages: HostedChatMessage[] = [
      { role: "system", content: "Be exact." },
      { role: "user", content: "Find Atlas." },
      { role: "assistant", content: null, tool_calls: [{ id: "call_1", type: "function", function: { name: "search_crm", arguments: '{"query":"Atlas","fields":["account_id"],"cursor":null,"limit":10}' } }] },
      { role: "tool", tool_call_id: "call_1", content: '{"items":[{"account_id":"train_1_acct_001"}]}' },
    ];
    const serialized = serializeLocalAdapterMessages({ messages, tools });
    expect(serialized[0]?.content).toBe(CROSS_SYSTEM_LOCAL_TOOL_SYSTEM_PROMPT);
    expect(serialized[0]?.content).toContain("LOCAL TOOL PROTOCOL");
    expect(serialized[0]?.content).toContain(CROSS_SYSTEM_BOOTSTRAP_SYSTEM_PROMPT);
    expect(serialized[0]?.content).toContain("search_crm");
    expect(serialized[0]?.content).not.toContain("Results are scoped, projected, paginated");
    expect(serialized[0]?.content.length).toBeLessThan(2_500);
    expect(serialized.some((message) => message.role === "assistant" && message.content.includes('"type":"tool_call"'))).toBe(true);
    expect(serialized.some((message) => message.role === "user" && message.content.includes('"type":"tool_result"'))).toBe(true);
    expect(serialized.some((message) => message.role === "assistant" && message.content.includes('"id"'))).toBe(false);
    expect(serialized.some((message) => message.content.includes('"tool_call_id"'))).toBe(false);
    expect(JSON.parse(serialized.at(-1)!.content)).toEqual({
      type: "tool_result",
      name: "search_crm",
      ok: true,
      result: { items: [{ account_id: "train_1_acct_001" }] },
      error: null,
    });
  });

  test("normalizes runtime result wrappers to the same compact named envelope used for training", () => {
    const serialized = serializeLocalAdapterMessages({
      messages: [
        { role: "user", content: "Find Atlas." },
        { role: "assistant", content: null, tool_calls: [{ id: "provider_call_123", type: "function", function: { name: "search_crm", arguments: '{"query":"Atlas","fields":["account_id"],"cursor":null,"limit":10}' } }] },
        { role: "tool", tool_call_id: "provider_call_123", content: JSON.stringify({ ok: true, action: "search_crm", output: "Rendered summary", data: { items: [{ account_id: "acct_1" }] }, evidence: { rows: 1 } }) },
      ],
      tools,
    });
    const toolResult = serialized.find((message) => message.role === "user" && message.content.includes('"type":"tool_result"'));
    expect(toolResult).toBeDefined();
    expect(JSON.parse(toolResult!.content)).toEqual({
      type: "tool_result",
      name: "search_crm",
      ok: true,
      result: { items: [{ account_id: "acct_1" }] },
      error: null,
    });
    expect(toolResult!.content).not.toContain("provider_call_123");
    expect(toolResult!.content).not.toContain("Rendered summary");
    expect(toolResult!.content).not.toContain("evidence");
  });

  test("rejects an orphaned tool result instead of inventing model-visible correlation metadata", () => {
    expect(() => serializeLocalAdapterMessages({
      messages: [{ role: "user", content: "Find Atlas." }, { role: "tool", tool_call_id: "missing", content: "{}" }],
      tools,
    })).toThrow("without a matching registered tool call");
  });

  test("enforces the 15-turn bound and excludes production credentials from the worker", () => {
    const messages: HostedChatMessage[] = Array.from({ length: LOCAL_ADAPTER_MAX_TOOL_TURNS }, (_, index) => ({ role: "assistant" as const, tool_calls: [{ id: `call_${index}`, type: "function", function: { name: "search_crm", arguments: "{}" } }] }));
    expect(() => assertLocalAdapterToolBudget(messages)).toThrow("15-turn budget");
    const env = localAdapterWorkerEnv({ PATH: "/usr/bin", HOME: "/tmp/home", OPENAI_API_KEY: "secret", AWS_SECRET_ACCESS_KEY: "secret" });
    expect(env.PATH).toBe("/usr/bin");
    expect(env.OPENAI_API_KEY).toBeUndefined();
    expect(env.AWS_SECRET_ACCESS_KEY).toBeUndefined();
    expect(env.HF_HUB_OFFLINE).toBe("1");
  });

  test("sends the configured token window to inference and strips unsupported message fields", () => {
    const request = localAdapterInferenceRequest({
      id: "request_1",
      messages: [
        { role: "system", content: "Use tools." },
        { role: "assistant", content: null, tool_calls: [{ id: "hidden", type: "function", function: { name: "search_crm", arguments: "{}" } }] },
        { role: "user", content: "Find Atlas." },
      ],
      maxNewTokens: 192,
      contextWindowTokens: 1_024,
      temperature: 0,
      repetitionPenalty: 1,
      noRepeatNgramSize: 0,
    });
    expect(request.contextWindowTokens).toBe(1_024);
    expect(request.messages).toEqual([
      { role: "system", content: "Use tools." },
      { role: "user", content: "Find Atlas." },
    ]);
  });

  test("advertises native tool calling only for a fully conformed flagship Taskset", () => {
    const plain = tasksetFixture();
    expect(supportsCrossSystemToolCalling(plain)).toBe(false);
    const conformed = {
      ...plain,
      environment: {
        ...plain.environment,
        stateful: true,
        networkPolicy: "none" as const,
        toolNames: [...CROSS_SYSTEM_TOOL_NAMES],
        metadata: { toolContractHash: CROSS_SYSTEM_TOOL_CONTRACT_HASH },
      },
      capabilities: { ...plain.capabilities, requiresTools: true },
      metadata: { ...plain.metadata, toolContractHash: CROSS_SYSTEM_TOOL_CONTRACT_HASH },
    };
    expect(supportsCrossSystemToolCalling(conformed)).toBe(true);
    expect(nativeToolTransportEnabledForProvider(resolveHostedToolRolloutFlags(), "local-adapter")).toBe(true);
  });

  test("projects the selected normal project actions as the four direct tools and executes through the shared renderer", async () => {
    const calls: Array<Record<string, unknown>> = [];
    const definitions = createOpenPondActionModelToolDefinitions({
      actionCatalog: CROSS_SYSTEM_TOOL_NAMES.map((name) => ({ id: name, sourceActionId: name, name, label: name, implementation: { type: "tool", projectId: "project_cso" } })),
      executeWorkspaceTool: async () => ({ ok: false, action: "unused", output: "unused", data: null } as any),
      executeCrossSystemTool: async (input) => {
        calls.push(input);
        return { toolCallId: input.callId, name: input.name, ok: true, contentText: JSON.stringify({ rendered: true }) };
      },
    });
    const direct = definitions.filter((definition) => (CROSS_SYSTEM_TOOL_NAMES as readonly string[]).includes(definition.name));
    expect(direct.map((definition) => definition.name)).toEqual(CROSS_SYSTEM_TOOL_NAMES);
    const result = await direct[0]!.execute({ model: "lineage_cso", session: { localProjectId: "project_cso", workspaceKind: "local_project", workspaceId: "project_cso" }, turnId: "turn_cso", callId: "call_cso", args: { query: "Atlas", fields: ["account_id"], cursor: null, limit: 10 }, userPrompt: "Generated question", turnMetadata: { crossSystemTaskId: "cso_task_validation_1" }, signal: new AbortController().signal } as any);
    expect(result).toMatchObject({ ok: true, name: "search_crm" });
    expect(calls[0]).toMatchObject({ modelId: "lineage_cso", localProjectId: "project_cso", turnId: "turn_cso", name: "search_crm", taskId: "cso_task_validation_1" });
  });

  test("cancels in-flight persistent sandbox work instead of leaving a worker behind", async () => {
    const sandbox = new PersistentPythonSandbox({ timeoutMs: 5_000 });
    const controller = new AbortController();
    const execution = sandbox.run("while True:\n    pass", controller.signal);
    setTimeout(() => controller.abort(new Error("stop requested")), 20);
    await expect(execution).rejects.toThrow("stop requested");
    await sandbox.close();
  });

  test("binds normal chat tools to the selected model's versioned synthetic Taskset world", async () => {
    const trainWorld = generateCrossSystemWorld({ seed: 101, split: "train", difficulty: "easy" });
    const validationWorld = generateCrossSystemWorld({ seed: 102, split: "validation", difficulty: "easy" });
    const trainTask = generateCrossSystemTasks(trainWorld)[0]!;
    const generatedTask = generateCrossSystemTasks(validationWorld)[0]!;
    expect(trainTask.prompt).toBe(generatedTask.prompt);
    const plain = tasksetFixture();
    const taskset = {
      ...plain,
      sourceRefs: plain.sourceRefs.map((source) => ({ ...source, workspaceId: "project_cso" })),
      tasks: [
        { ...plain.tasks[0]!, input: { prompt: trainTask.prompt }, metadata: { ...plain.tasks[0]!.metadata, taskId: trainTask.id } },
        { ...plain.tasks[1]!, input: { prompt: generatedTask.prompt }, metadata: { ...plain.tasks[1]!.metadata, taskId: generatedTask.id } },
      ],
      environment: { ...plain.environment, stateful: true, networkPolicy: "none" as const, toolNames: [...CROSS_SYSTEM_TOOL_NAMES], metadata: { toolContractHash: CROSS_SYSTEM_TOOL_CONTRACT_HASH } },
      capabilities: { ...plain.capabilities, requiresTools: true },
      metadata: { ...plain.metadata, toolContractHash: CROSS_SYSTEM_TOOL_CONTRACT_HASH, worldSpecs: [{ seed: 101, split: "train", difficulty: "easy" }, { seed: 102, split: "validation", difficulty: "easy" }] },
    };
    let gradedAttemptInput: any = null;
    const runtime = createCrossSystemChatToolRuntime({
      store: {
        getModelArtifactLineage: async () => ({ id: "lineage_cso", tasksetId: taskset.id, status: "imported" }),
        getTaskset: async () => taskset,
        runtimeEventsForSession: async () => [
          { id: "event_turn_started", sessionId: "session_chat", turnId: "turn_chat", name: "turn.started", timestamp: "2026-07-15T10:00:00.000Z", source: "chat_action", status: "started" },
          { id: "event_tool_started", sessionId: "session_chat", turnId: "turn_chat", name: "tool.started", timestamp: "2026-07-15T10:00:00.250Z", source: "provider", status: "started" },
          { id: "event_tool_completed", sessionId: "session_chat", turnId: "turn_chat", name: "tool.completed", timestamp: "2026-07-15T10:00:00.500Z", source: "provider", status: "completed" },
          { id: "event_answer", sessionId: "session_chat", turnId: "turn_chat", name: "assistant.delta", timestamp: "2026-07-15T10:00:01.000Z", source: "provider", output: "ANSWER: {}" },
          { id: "event_turn_completed", sessionId: "session_chat", turnId: "turn_chat", name: "turn.completed", timestamp: "2026-07-15T10:00:01.000Z", source: "provider", status: "completed" },
          { id: "event_failed_started", sessionId: "session_failed", turnId: "turn_failed", name: "turn.started", timestamp: "2026-07-15T10:01:00.000Z", source: "chat_action", status: "started" },
          { id: "event_failed_terminal", sessionId: "session_failed", turnId: "turn_failed", name: "turn.failed", timestamp: "2026-07-15T10:01:01.000Z", source: "provider", status: "failed", error: "Local model emitted malformed tool-call JSON." },
        ],
      } as any,
      idleTimeoutMs: 1_000,
      gradeAttempt: async (received) => {
        gradedAttemptInput = received;
        return { id: "grade_chat" };
      },
    });
    try {
      const result = await runtime.execute({ modelId: "lineage_cso", localProjectId: "project_cso", turnId: "turn_chat", callId: "call_chat", name: "search_crm", args: { query: "*", fields: ["account_id", "renewal_date"], cursor: null, limit: 2 }, userPrompt: generatedTask.prompt, taskId: generatedTask.id, signal: new AbortController().signal });
      expect(result.ok).toBe(true);
      expect(result.contentText).toContain(CROSS_SYSTEM_TOOL_CONTRACT_HASH);
      expect((result.data as any).evidence.rows).toBe(2);
      expect((result.data as any).result.items[0].account_id).toStartWith("validation_102_");
      await expect(runtime.execute({ modelId: "lineage_cso", localProjectId: "project_other", turnId: "turn_wrong_project", callId: "call_wrong_project", name: "search_crm", args: { query: "*", fields: ["account_id"], cursor: null, limit: 2 }, userPrompt: generatedTask.prompt, taskId: generatedTask.id, signal: new AbortController().signal })).rejects.toThrow("not attached to this model Taskset's source");
      await expect(runtime.execute({ modelId: "lineage_cso", localProjectId: "project_cso", turnId: "turn_ambiguous", callId: "call_ambiguous", name: "search_crm", args: { query: "*", fields: ["account_id"], cursor: null, limit: 2 }, userPrompt: generatedTask.prompt, signal: new AbortController().signal })).rejects.toThrow("multiple synthetic worlds");
      const finalized = await runtime.finalize({
        modelId: "lineage_cso",
        localProjectId: "project_cso",
        sessionId: "session_chat",
        turnId: "turn_chat",
        userPrompt: generatedTask.prompt,
        taskId: generatedTask.id,
        startedAt: "2026-07-15T10:00:00.000Z",
        completedAt: "2026-07-15T10:00:01.000Z",
      });
      expect(finalized).toEqual({ attemptId: "attempt_chat_turn_chat", gradeId: "grade_chat", generatedTaskId: generatedTask.id });
      expect(gradedAttemptInput).toMatchObject({
        tasksetId: taskset.id,
        taskId: taskset.tasks[1]!.id,
        attempt: {
          id: "attempt_chat_turn_chat",
          output: { text: "ANSWER: {}" },
          runtimeEventRefs: ["event_turn_started", "event_tool_started", "event_tool_completed", "event_answer", "event_turn_completed"],
          metadata: {
            source: "normal_openpond_chat",
            sessionId: "session_chat",
            turnId: "turn_chat",
            generatedTaskId: generatedTask.id,
            toolEventRefs: ["event_tool_started", "event_tool_completed"],
          },
        },
      });
      const failedFinalized = await runtime.finalize({
        modelId: "lineage_cso",
        localProjectId: "project_cso",
        sessionId: "session_failed",
        turnId: "turn_failed",
        userPrompt: generatedTask.prompt,
        taskId: generatedTask.id,
        startedAt: "2026-07-15T10:01:00.000Z",
        completedAt: "2026-07-15T10:01:01.000Z",
        terminalFailure: {
          message: "Local model emitted malformed tool-call JSON.",
          failureClass: "policy_failure",
        },
      });
      expect(failedFinalized).toEqual({ attemptId: "attempt_chat_turn_failed", gradeId: "grade_chat", generatedTaskId: generatedTask.id });
      expect(gradedAttemptInput).toMatchObject({
        attempt: {
          id: "attempt_chat_turn_failed",
          output: {},
          infrastructureError: null,
          runtimeEventRefs: ["event_failed_started", "event_failed_terminal"],
          metadata: {
            terminalFailure: "Local model emitted malformed tool-call JSON.",
            terminalFailureClass: "policy_failure",
          },
        },
      });
    } finally {
      await runtime.close();
    }
  });
});
