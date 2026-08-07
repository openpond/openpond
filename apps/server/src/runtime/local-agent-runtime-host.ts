import {
  AGENT_PROTOCOL_VERSION,
  AGENT_RPC_METHODS,
  canonicalHash,
  type AgentProtocolCapabilities,
  type AgentRuntimeHost,
  type JsonRpcNotification,
} from "@openpond/agent-runtime";
import type { Approval, RuntimeEvent, Session, Turn } from "@openpond/contracts";
import { z } from "zod";

const ThreadIdParamsSchema = z.object({ threadId: z.string().trim().min(1) }).passthrough();
const ThreadStartParamsSchema = z.object({ session: z.unknown() }).strict();
const TurnParamsSchema = ThreadIdParamsSchema.extend({ input: z.unknown() });
const InterruptParamsSchema = ThreadIdParamsSchema.extend({ reason: z.string().trim().min(1).optional() });
const ApprovalParamsSchema = z.object({ approvalId: z.string().trim().min(1), input: z.unknown() }).strict();

export function createLocalAgentRuntimeHost(deps: {
  createSession(payload: unknown): Promise<Session>;
  getSession(sessionId: string): Promise<Session>;
  turnsForSession(sessionId: string): Promise<Turn[]>;
  runtimeEventsForSession(sessionId: string): Promise<RuntimeEvent[]>;
  sendTurn(sessionId: string, payload: unknown): Promise<Turn>;
  isSessionTurnActive(sessionId: string): boolean;
  waitForSessionTurnSettlement(sessionId: string): Promise<void>;
  interruptSessionTurn(sessionId: string, reason?: string): Promise<Turn>;
  resolveApproval(approvalId: string, payload: unknown): Promise<Approval>;
  inspectHarness(): Promise<unknown>;
  validateHarness(): Promise<unknown>;
  subscribeRuntimeEvents(listener: (event: RuntimeEvent) => void): () => void;
}): AgentRuntimeHost {
  const toolCatalogHash = canonicalHash([]);
  const capabilities = async (params?: unknown): Promise<AgentProtocolCapabilities> => {
    const parsed = z.object({ threadId: z.string().trim().min(1).optional() }).passthrough().safeParse(params ?? {});
    const latestTurn = parsed.success && parsed.data.threadId
      ? (await deps.turnsForSession(parsed.data.threadId))[0]
      : null;
    const recordedTools = Array.isArray(latestTurn?.metadata.toolCapabilities)
      ? latestTurn.metadata.toolCapabilities.filter(
          (tool): tool is Record<string, unknown> => Boolean(tool) && typeof tool === "object" && !Array.isArray(tool),
        )
      : [];
    const recordedHash = typeof latestTurn?.metadata.toolCatalogHash === "string"
      ? latestTurn.metadata.toolCatalogHash
      : toolCatalogHash;
    return {
      protocolVersion: AGENT_PROTOCOL_VERSION,
      placement: "local",
      methods: [...AGENT_RPC_METHODS],
      features: {
        streamingEvents: true,
        interruption: true,
        approvals: true,
        userInput: true,
        compaction: true,
        harnessInspection: true,
        harnessValidation: true,
        immutableHarnessAdmission: true,
      },
      tools: recordedTools,
      toolCatalogHash: recordedHash,
    };
  };

  const threadRead = async (params: unknown) => {
    const { threadId } = ThreadIdParamsSchema.parse(params);
    const [session, turns, events] = await Promise.all([
      deps.getSession(threadId),
      deps.turnsForSession(threadId),
      deps.runtimeEventsForSession(threadId),
    ]);
    return { thread: session, turns, events };
  };

  return {
    capabilities,
    threadStart: async (params) => ({ thread: await deps.createSession(ThreadStartParamsSchema.parse(params).session) }),
    threadResume: threadRead,
    threadRead,
    turnStart: async (params) => {
      const input = TurnParamsSchema.parse(params);
      return { turn: await deps.sendTurn(input.threadId, input.input) };
    },
    turnSteer: async (params) => {
      const input = TurnParamsSchema.parse(params);
      if (deps.isSessionTurnActive(input.threadId)) await deps.waitForSessionTurnSettlement(input.threadId);
      return { turn: await deps.sendTurn(input.threadId, input.input) };
    },
    turnInterrupt: async (params) => {
      const input = InterruptParamsSchema.parse(params);
      return { turn: await deps.interruptSessionTurn(input.threadId, input.reason) };
    },
    approvalResolve: async (params) => {
      const input = ApprovalParamsSchema.parse(params);
      return { approval: await deps.resolveApproval(input.approvalId, input.input) };
    },
    userInputResolve: async (params) => {
      const input = TurnParamsSchema.parse(params);
      if (deps.isSessionTurnActive(input.threadId)) await deps.waitForSessionTurnSettlement(input.threadId);
      return { turn: await deps.sendTurn(input.threadId, input.input) };
    },
    harnessInspect: () => deps.inspectHarness(),
    harnessValidate: () => deps.validateHarness(),
    subscribe: (listener) => deps.subscribeRuntimeEvents((event) => listener(runtimeEventNotification(event))),
  };
}

function runtimeEventNotification(event: RuntimeEvent): JsonRpcNotification {
  return { jsonrpc: "2.0", method: notificationMethod(event.name), params: event };
}

function notificationMethod(name: RuntimeEvent["name"]): string {
  if (name === "turn.started") return "turn/started";
  if (name === "turn.completed") return "turn/completed";
  if (name === "turn.failed") return "turn/failed";
  if (name === "turn.interrupted") return "turn/interrupted";
  if (name === "assistant.delta") return "item/assistantDelta";
  if (name === "assistant.reasoning.delta") return "item/reasoningDelta";
  if (name === "tool.started") return "item/toolStarted";
  if (name === "tool.completed") return "item/toolCompleted";
  if (name === "approval.requested") return "approval/requested";
  if (name === "approval.resolved") return "approval/resolved";
  if (name.startsWith("session.compaction.")) return name.replace("session.compaction.", "compaction/");
  if (name.startsWith("harness.")) return name.replace("harness.", "harness/").replaceAll(".", "_");
  return "turn/event";
}
