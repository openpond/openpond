import {
  CreateChatWorkflowRequestSchema,
  CreateHostedSavedWorkRequestSchema,
  UpdateChatWorkflowRequestSchema,
  type CreateHostedSavedWorkRequest,
  type Session,
  type Turn,
} from "@openpond/contracts";
import type { BackgroundWorkerQueue } from "../runtime/background-worker-queue.js";
import type { SqliteStore } from "../store/store.js";
import { now } from "../utils.js";
import { createChatWorkflowLoop, type ChatWorkflowLoop } from "./chat-workflow-scheduler.js";

type Logger = {
  warn(message: string, metadata?: Record<string, unknown>): void;
};

export function createChatWorkflowRuntime(options: {
  store: SqliteStore;
  queue: BackgroundWorkerQueue;
  getSession(sessionId: string): Promise<Session>;
  createHostedSavedWork(input: CreateHostedSavedWorkRequest): Promise<Record<string, unknown>>;
  isClosing(): boolean;
  logger?: Logger;
}) {
  let loop: ChatWorkflowLoop | null = null;

  function requiredLoop(): ChatWorkflowLoop {
    if (!loop) throw new Error("Chat workflows are still starting.");
    return loop;
  }

  const routePayloads = {
    async listChatWorkflowsPayload(sessionId?: string | null) {
      const active = requiredLoop();
      const [workflows, runs] = await Promise.all([
        active.list(sessionId),
        active.listRuns(),
      ]);
      return { workflows, runs, asOf: now() };
    },
    async createChatWorkflowPayload(payload: unknown) {
      return {
        workflow: await requiredLoop().create(
          CreateChatWorkflowRequestSchema.parse(payload),
        ),
      };
    },
    async patchChatWorkflowPayload(workflowId: string, payload: unknown) {
      const workflow = await requiredLoop().patch(
        workflowId,
        UpdateChatWorkflowRequestSchema.parse(payload),
      );
      if (!workflow) throw new Error("Chat workflow not found.");
      return { workflow };
    },
    async deleteChatWorkflowPayload(workflowId: string) {
      if (!(await requiredLoop().remove(workflowId))) {
        throw new Error("Chat workflow not found.");
      }
      return { ok: true };
    },
    async runChatWorkflowPayload(workflowId: string) {
      return { run: await requiredLoop().runNow(workflowId) };
    },
  };

  return {
    routePayloads,
    bindTurnRuntime(input: {
      sendTurn(sessionId: string, payload: unknown): Promise<Turn>;
      isSessionTurnActive(sessionId: string): boolean;
    }) {
      loop = createChatWorkflowLoop({
        store: options.store,
        queue: options.queue,
        getSession: options.getSession,
        sendTurn: input.sendTurn,
        isSessionTurnActive: input.isSessionTurnActive,
        isClosing: options.isClosing,
        logger: options.logger,
      });
    },
    async createScheduledWork(rawInput: CreateHostedSavedWorkRequest) {
      const input = CreateHostedSavedWorkRequestSchema.parse(rawInput);
      if (!input.targetSessionId) return options.createHostedSavedWork(input);
      const workflow = await requiredLoop().create(
        CreateChatWorkflowRequestSchema.parse({
          sessionId: input.targetSessionId,
          sourceTurnId: input.sourceTurnId,
          name: input.name,
          prompt: input.prompt,
          recurrence: input.recurrence,
        }),
      );
      return {
        workflow,
        delivery: { kind: "chat", sessionId: workflow.sessionId },
      };
    },
    start() {
      requiredLoop().start();
    },
    stop() {
      return requiredLoop().stop();
    },
  };
}
