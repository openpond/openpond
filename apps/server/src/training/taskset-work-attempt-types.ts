import type {
  ChatModelRef,
  CodexReasoningEffort,
  RuntimeEvent,
  Session,
  WorkspaceDiffSummary,
  WorkspaceToolResult,
} from "@openpond/contracts";
import type {
  HostedChatContinuation,
  HostedChatMessage,
  HostedChatTool,
  HostedChatToolCall,
  HostedChatToolChoice,
} from "@openpond/cloud";

import type { NativeModelToolResult } from "../openpond/native-tool-calls.js";
import type { HostedTokenPricing } from "./hosted-token-pricing.js";

export type TasksetWorkModelDelta = {
  text?: string;
  continuation?: HostedChatContinuation;
  toolCalls?: HostedChatToolCall[];
  usage?: unknown;
  costUsd?: number;
};

export type TasksetWorkModelStream = (input: {
  model: ChatModelRef;
  reasoningEffort: CodexReasoningEffort | "none" | null;
  messages: HostedChatMessage[];
  tools: HostedChatTool[];
  toolChoice: HostedChatToolChoice;
  requestId: string;
  signal: AbortSignal;
  maxOutputTokens?: number;
  temperature?: number;
  topP?: number;
  seed?: number;
  hostedTokenPricing?: HostedTokenPricing;
}) => AsyncIterable<TasksetWorkModelDelta>;

export type TasksetWorkToolEvidence = {
  execute(input: {
    taskId: string;
    callId: string;
    toolName: string;
    args: Record<string, unknown>;
    execute: () => Promise<NativeModelToolResult>;
  }): Promise<NativeModelToolResult>;
};

export type TasksetWorkAttemptRuntime = {
  createSession(payload: unknown): Promise<Session>;
  getSession(sessionId: string): Promise<Session>;
  executeWorkspaceTool(
    sessionId: string,
    payload: unknown,
    options?: {
      turnId?: string;
      workspaceDiffBaseline?: WorkspaceDiffSummary | null;
    },
  ): Promise<WorkspaceToolResult>;
  runtimeEventsForSession(sessionId: string): Promise<RuntimeEvent[]>;
  settleCostEvidence?(
    sessionId: string,
    options?: { turnId?: string },
  ): Promise<WorkspaceToolResult>;
};

export type WorkTraceStep =
  | { kind: "model"; turn: number; text: string; toolCallCount: number }
  | {
      kind: "tool";
      turn: number;
      callId: string;
      name: string;
      arguments: Record<string, unknown>;
      ok: boolean;
      output: string;
    }
  | { kind: "required_output"; path: string; ok: boolean; detail: string }
  | { kind: "cleanup"; ok: boolean; detail: string };
