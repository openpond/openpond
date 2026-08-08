import { z } from "zod";

import type {
  AgentProtocolCapabilities,
  AgentRuntimeHost,
  JsonRpcNotification,
} from "./protocol.js";

const ThreadIdParamsSchema = z.object({ threadId: z.string().trim().min(1) }).passthrough();
const ThreadStartParamsSchema = z.object({ session: z.unknown() }).strict();
const TurnParamsSchema = ThreadIdParamsSchema.extend({ input: z.unknown() });
const InterruptParamsSchema = ThreadIdParamsSchema.extend({ reason: z.string().trim().min(1).optional() });
const ApprovalParamsSchema = z.object({ approvalId: z.string().trim().min(1), input: z.unknown() }).strict();

export type AgentRuntimeServicePorts<TThread, TTurn, TEvent, TApproval> = {
  capabilities(params?: unknown): Promise<AgentProtocolCapabilities>;
  createThread(payload: unknown): Promise<TThread>;
  readThread(threadId: string): Promise<TThread>;
  listTurns(threadId: string): Promise<TTurn[]>;
  listEvents(threadId: string): Promise<TEvent[]>;
  startTurn(threadId: string, payload: unknown): Promise<TTurn>;
  isTurnActive(threadId: string): boolean;
  waitForTurnSettlement(threadId: string): Promise<void>;
  interruptTurn(threadId: string, reason?: string): Promise<TTurn>;
  resolveApproval(approvalId: string, payload: unknown): Promise<TApproval>;
  inspectHarness(): Promise<unknown>;
  reviewHarnessProposal(params: unknown): Promise<unknown>;
  reviewHarness(params: unknown): Promise<unknown>;
  acceptHarnessEvaluationReview(params: unknown): Promise<unknown>;
  materializeHarnessEvaluationTaskset(params: unknown): Promise<unknown>;
  validateHarness(): Promise<unknown>;
  updateHarnessBackgroundReview(payload: unknown): Promise<unknown>;
  diffHarness(payload: unknown): Promise<unknown>;
  rollbackHarness(payload: unknown): Promise<unknown>;
  subscribeEvents?(listener: (event: TEvent) => void): () => void;
  eventNotification?(event: TEvent): JsonRpcNotification;
  telemetry?(event: AgentRuntimeTelemetryEvent): void;
};

export type AgentRuntimeTelemetryEvent = {
  method: "runtime/capabilities" | "thread/start" | "thread/read" | "thread/resume" |
    "turn/start" | "turn/steer" | "turn/interrupt" | "approval/resolve" |
    "userInput/resolve" | "harness/inspect" | "harness/proposalReview" |
    "harness/review" | "harness/acceptEvaluationReview" |
    "harness/materializeEvaluationTaskset" | "harness/validate" |
    "harness/backgroundReview" | "harness/diff" | "harness/rollback";
  phase: "started" | "completed" | "failed";
  threadId: string | null;
  durationMs: number | null;
  errorClass: string | null;
};

/**
 * Canonical transport-neutral thread/turn service. HTTP, JSON-RPC, and future
 * hosted transports must call this service instead of composing lifecycle
 * operations independently.
 */
export function createAgentRuntimeService<TThread, TTurn, TEvent, TApproval>(
  ports: AgentRuntimeServicePorts<TThread, TTurn, TEvent, TApproval>,
): AgentRuntimeHost {
  const run = async <T>(
    method: AgentRuntimeTelemetryEvent["method"],
    threadId: string | null,
    operation: () => Promise<T>,
  ): Promise<T> => {
    const startedAt = performance.now();
    ports.telemetry?.({ method, phase: "started", threadId, durationMs: null, errorClass: null });
    try {
      const result = await operation();
      ports.telemetry?.({
        method,
        phase: "completed",
        threadId,
        durationMs: performance.now() - startedAt,
        errorClass: null,
      });
      return result;
    } catch (error) {
      ports.telemetry?.({
        method,
        phase: "failed",
        threadId,
        durationMs: performance.now() - startedAt,
        errorClass: error instanceof Error ? error.name : "UnknownError",
      });
      throw error;
    }
  };

  const threadRead = async (params: unknown, method: "thread/read" | "thread/resume" = "thread/read") => {
    const { threadId } = ThreadIdParamsSchema.parse(params);
    return run(method, threadId, async () => {
      const [thread, turns, events] = await Promise.all([
        ports.readThread(threadId),
        ports.listTurns(threadId),
        ports.listEvents(threadId),
      ]);
      return { thread, turns, events };
    });
  };

  return {
    capabilities: (params) => run("runtime/capabilities", null, () => ports.capabilities(params)),
    threadStart: async (params) => run("thread/start", null, async () => ({
      thread: await ports.createThread(ThreadStartParamsSchema.parse(params).session),
    })),
    threadResume: (params) => threadRead(params, "thread/resume"),
    threadRead,
    turnStart: async (params) => {
      const input = TurnParamsSchema.parse(params);
      return run("turn/start", input.threadId, async () => ({
        turn: await ports.startTurn(input.threadId, input.input),
      }));
    },
    turnSteer: async (params) => {
      const input = TurnParamsSchema.parse(params);
      return run("turn/steer", input.threadId, async () => {
        if (ports.isTurnActive(input.threadId)) {
          await ports.waitForTurnSettlement(input.threadId);
        }
        return { turn: await ports.startTurn(input.threadId, input.input) };
      });
    },
    turnInterrupt: async (params) => {
      const input = InterruptParamsSchema.parse(params);
      return run("turn/interrupt", input.threadId, async () => ({
        turn: await ports.interruptTurn(input.threadId, input.reason),
      }));
    },
    approvalResolve: async (params) => {
      const input = ApprovalParamsSchema.parse(params);
      return run("approval/resolve", null, async () => ({
        approval: await ports.resolveApproval(input.approvalId, input.input),
      }));
    },
    userInputResolve: async (params) => {
      const input = TurnParamsSchema.parse(params);
      return run("userInput/resolve", input.threadId, async () => {
        if (ports.isTurnActive(input.threadId)) {
          await ports.waitForTurnSettlement(input.threadId);
        }
        return { turn: await ports.startTurn(input.threadId, input.input) };
      });
    },
    harnessInspect: () => run("harness/inspect", null, () => ports.inspectHarness()),
    harnessProposalReview: (params) =>
      run("harness/proposalReview", null, () => ports.reviewHarnessProposal(params)),
    harnessReview: (params) => run("harness/review", null, () => ports.reviewHarness(params)),
    harnessAcceptEvaluationReview: (params) =>
      run("harness/acceptEvaluationReview", null, () => ports.acceptHarnessEvaluationReview(params)),
    harnessMaterializeEvaluationTaskset: (params) =>
      run("harness/materializeEvaluationTaskset", null, () =>
        ports.materializeHarnessEvaluationTaskset(params)),
    harnessValidate: () => run("harness/validate", null, () => ports.validateHarness()),
    harnessBackgroundReview: (params) =>
      run("harness/backgroundReview", null, () => ports.updateHarnessBackgroundReview(params)),
    harnessDiff: (params) =>
      run("harness/diff", null, () => ports.diffHarness(params)),
    harnessRollback: (params) =>
      run("harness/rollback", null, () => ports.rollbackHarness(params)),
    subscribe: ports.subscribeEvents && ports.eventNotification
      ? (listener) => ports.subscribeEvents!((event) => listener(ports.eventNotification!(event)))
      : undefined,
  };
}
