import { randomUUID } from "node:crypto";
import { taskInputModelText } from "@openpond/contracts/task-inbox";
import type { Session } from "@openpond/contracts/sessions";
import type { TaskInboxRuntime } from "../task-inbox/runtime.js";
import type { TaskInboxRepository } from "../task-inbox/repository.js";
import type { createNativeAgentRuntime } from "./runtime.js";

type NativeRuntime = ReturnType<typeof createNativeAgentRuntime>;
type NativeInput = Parameters<NativeRuntime["run"]>[0];

/** Replace only the native request on Steer; Stop still cancels the entire turn. */
export async function runSteeredNativeTurn({ runtime, inbox, store, getSession, input }: {
  runtime: Pick<NativeRuntime, "run">;
  inbox: TaskInboxRuntime;
  store: TaskInboxRepository;
  getSession(sessionId: string): Promise<Session>;
  input: Omit<NativeInput, "preparePrompt" | "settlePrompt" | "requestId" | "requestOrdinal">;
}): Promise<string> {
  const sessionId = input.session.id;
  for (let ordinal = 0; ; ordinal++) {
    input.signal.throwIfAborted();
    const request = inbox.beginRequest(sessionId, input.signal);
    const requestId = `native-request:${input.turn.id}:${randomUUID()}`;
    let providerTurnId: string;
    try {
      providerTurnId = await runtime.run({
        ...input,
        // A cancelled, unresponsive native process may have been closed. Resume
        // its persisted session identity instead of creating a fresh conversation.
        session: ordinal ? await getSession(sessionId) : input.session,
        requestId,
        requestOrdinal: ordinal,
        signal: request.signal,
        preparePrompt: async (prompt) => {
          const included = await inbox.include(sessionId, input.turn.id, requestId);
          const corrections = await store.taskAssignmentInputs(input.turn.id);
          const messages = included.filter((message) => message.kind !== "steer" && message.id !== input.turn.metadata?.taskInputId);
          const assignment = ordinal === 0 ? prompt : [
            "Continue the same assignment with the corrections below. Preserve completed work and the original objective unless the user explicitly changes it. Do not repeat completed actions.",
            `Original assignment: ${input.turn.prompt}`,
          ].join("\n\n");
          return [assignment, ...corrections.map(taskInputModelText), ...messages.map(taskInputModelText)].join("\n\n");
        },
      });
      input.signal.throwIfAborted();
      await store.settleTaskInputRequest(requestId, request.replaced() ? "replaced" : "resolved");
      if (request.replaced()) continue;
    } catch (error) {
      await store.settleTaskInputRequest(requestId, request.replaced() ? "replaced" : "failed");
      if (request.replaced()) continue;
      throw error;
    } finally {
      request.finish();
    }
    input.signal.throwIfAborted();
    // Admission and completion share a transaction: a late accepted correction
    // gets another request, while an already-finished turn rejects new steering.
    if (await store.sealTaskInboxTurn(sessionId, input.turn.id, inbox.ownerId)) return providerTurnId;
  }
}
