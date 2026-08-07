import {
  AGENT_PROTOCOL_VERSION,
  AGENT_RPC_METHODS,
  CanonicalAgentEventSchema,
  canonicalHash,
  canonicalEventHash,
  type CanonicalAgentEvent,
  type AgentProtocolCapabilities,
  type AgentRuntimeHost,
  type JsonRpcNotification,
} from "@openpond/agent-runtime";
import { createAppServer } from "@openpond/app-server";
import type { Approval, RuntimeEvent, Session, Turn } from "@openpond/contracts";
import { z } from "zod";

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
  observeRuntimeOperation?(event: import("@openpond/agent-runtime").AgentRuntimeTelemetryEvent): void;
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

  return createAppServer({
    ports: {
      capabilities,
      createThread: deps.createSession,
      readThread: deps.getSession,
      listTurns: deps.turnsForSession,
      listEvents: deps.runtimeEventsForSession,
      startTurn: deps.sendTurn,
      isTurnActive: deps.isSessionTurnActive,
      waitForTurnSettlement: deps.waitForSessionTurnSettlement,
      interruptTurn: deps.interruptSessionTurn,
      resolveApproval: deps.resolveApproval,
      inspectHarness: deps.inspectHarness,
      validateHarness: deps.validateHarness,
      subscribeEvents: deps.subscribeRuntimeEvents,
      eventNotification: runtimeEventNotification,
      telemetry: deps.observeRuntimeOperation,
    },
  }).runtime;
}

function runtimeEventNotification(event: RuntimeEvent): JsonRpcNotification {
  const canonicalEvent = CanonicalAgentEventSchema.parse({
    sequence: event.sequence ?? 0,
    name: canonicalEventName(event.name),
    source: canonicalEventSource(event),
    status: event.status ?? null,
    threadId: event.sessionId ?? "unscoped",
    turnId: event.turnId ?? null,
    callId: runtimeEventCallId(event),
    output: event.output ?? null,
    error: event.error ?? null,
    data: {
      eventId: event.id,
      originalName: event.name,
      timestamp: event.timestamp,
      action: event.action ?? null,
      appId: event.appId ?? null,
      args: event.args ?? null,
      payload: event.data ?? null,
      relatedDeploymentId: event.relatedDeploymentId ?? null,
    },
  });
  return {
    jsonrpc: "2.0",
    method: notificationMethod(event.name),
    params: { ...canonicalEvent, contentHash: canonicalEventHash(canonicalEvent) },
  };
}

function canonicalEventName(name: RuntimeEvent["name"]): CanonicalAgentEvent["name"] {
  if (name === "session.started") return "thread.started";
  if (name === "session.compaction.started") return "compaction.started";
  if (name === "session.compaction.completed") return "compaction.completed";
  if (name === "session.compaction.failed") return "diagnostic";
  if (name === "user_question.asked") return "user_input.requested";
  if (name === "user_question.answered" || name === "user_question.dismissed") {
    return "user_input.resolved";
  }
  if (name === "skill.selected") return "item.started";
  if (name === "skill.loaded") return "item.completed";
  if (name === "assistant.delta") return "assistant.delta";
  if (name === "assistant.reasoning.delta") return "assistant.reasoning.delta";
  if (name === "approval.requested" || name === "approval.resolved" ||
      name === "turn.started" || name === "turn.completed" || name === "turn.failed" ||
      name === "turn.interrupted" || name === "tool.started" || name === "tool.completed" ||
      name === "harness.refiner.queued" ||
      name === "harness.refiner.started" || name === "harness.refiner.completed" ||
      name === "harness.refiner.failed") {
    return name;
  }
  return "diagnostic";
}

function canonicalEventSource(event: RuntimeEvent): CanonicalAgentEvent["source"] {
  if (event.name.startsWith("harness.refiner.")) return "refiner";
  if (event.source === "provider") return "provider";
  if (event.name.startsWith("tool.") || event.name.startsWith("workspace.") ||
      event.name === "workspace_action" || event.name === "workspace_action_result" ||
      event.name === "command.output") {
    return "tool";
  }
  return event.source === "server" ? "runtime" : "host";
}

function runtimeEventCallId(event: RuntimeEvent): string | null {
  const data = event.data && typeof event.data === "object" && !Array.isArray(event.data)
    ? event.data as Record<string, unknown>
    : {};
  for (const value of [data.toolCallId, data.callId, data.id]) {
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return null;
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
