import { describe, expect, test } from "bun:test";
import {
  CROSS_SYSTEM_TOOL_CONTRACT_HASH,
  CROSS_SYSTEM_TOOL_DEFINITIONS,
  CROSS_SYSTEM_TOOL_NAMES,
} from "@openpond/contracts";
import type { HostedChatMessage, HostedChatTool } from "@openpond/cloud";
import { localAdapterWorkerEnv } from "../apps/server/src/training/local-adapter-chat-runtime";
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

  test("preserves typed assistant calls and tool results in the next model generation", () => {
    const messages: HostedChatMessage[] = [
      { role: "system", content: "Be exact." },
      { role: "user", content: "Find Atlas." },
      { role: "assistant", content: null, tool_calls: [{ id: "call_1", type: "function", function: { name: "search_crm", arguments: '{"query":"Atlas","fields":["account_id"],"cursor":null,"limit":10}' } }] },
      { role: "tool", tool_call_id: "call_1", content: '{"items":[{"account_id":"train_1_acct_001"}]}' },
    ];
    const serialized = serializeLocalAdapterMessages({ messages, tools });
    expect(serialized[0]?.content).toContain("LOCAL TOOL PROTOCOL");
    expect(serialized.some((message) => message.role === "assistant" && message.content.includes('"type":"tool_call"'))).toBe(true);
    expect(serialized.some((message) => message.role === "user" && message.content.includes('"type":"tool_result"'))).toBe(true);
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
    const result = await direct[0]!.execute({ model: "lineage_cso", turnId: "turn_cso", callId: "call_cso", args: { query: "Atlas", fields: ["account_id"], cursor: null, limit: 10 }, userPrompt: "Generated question", signal: new AbortController().signal } as any);
    expect(result).toMatchObject({ ok: true, name: "search_crm" });
    expect(calls[0]).toMatchObject({ modelId: "lineage_cso", turnId: "turn_cso", name: "search_crm" });
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
    const world = generateCrossSystemWorld({ seed: 101, split: "frozen_eval", difficulty: "easy" });
    const generatedTask = generateCrossSystemTasks(world)[0]!;
    const plain = tasksetFixture();
    const taskset = {
      ...plain,
      tasks: [{ ...plain.tasks[0]!, input: { prompt: generatedTask.prompt }, metadata: { ...plain.tasks[0]!.metadata, taskId: generatedTask.id } }, plain.tasks[1]!],
      environment: { ...plain.environment, stateful: true, networkPolicy: "none" as const, toolNames: [...CROSS_SYSTEM_TOOL_NAMES], metadata: { toolContractHash: CROSS_SYSTEM_TOOL_CONTRACT_HASH } },
      capabilities: { ...plain.capabilities, requiresTools: true },
      metadata: { ...plain.metadata, toolContractHash: CROSS_SYSTEM_TOOL_CONTRACT_HASH, worldSpecs: [{ seed: 101, split: "frozen_eval", difficulty: "easy" }] },
    };
    const runtime = createCrossSystemChatToolRuntime({
      store: {
        getModelArtifactLineage: async () => ({ id: "lineage_cso", tasksetId: taskset.id, status: "imported" }),
        getTaskset: async () => taskset,
      } as any,
      idleTimeoutMs: 1_000,
    });
    try {
      const result = await runtime.execute({ modelId: "lineage_cso", turnId: "turn_chat", callId: "call_chat", name: "search_crm", args: { query: "*", fields: ["account_id", "renewal_date"], cursor: null, limit: 2 }, userPrompt: generatedTask.prompt, signal: new AbortController().signal });
      expect(result.ok).toBe(true);
      expect(result.contentText).toContain(CROSS_SYSTEM_TOOL_CONTRACT_HASH);
      expect((result.data as any).evidence.rows).toBe(2);
    } finally {
      await runtime.close();
    }
  });
});
