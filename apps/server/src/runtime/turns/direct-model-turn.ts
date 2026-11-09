import { isManagedDecisionChatModel } from "../../training/managed-decision-chat.js";
import { event } from "../../utils.js";
import { runDecisionScoringTurn } from "./decision-scoring-turn.js";
import type { TurnRunnerDependencies } from "./ports.js";

type Input = Omit<Parameters<typeof runDecisionScoringTurn>[0], "model"> & {
  model: string | null | undefined;
  remoteEnclave: boolean;
  enclaveChat: TurnRunnerDependencies["enclaveChat"];
  decisionContextUnsupported: boolean;
  throwIfInterrupted: (signal: AbortSignal) => void;
};

/** Direct model protocols bypass the language-model agent/tool loop. Keep
 * their dispatch and completion ownership separate from general turn setup. */
export async function runDirectModelTurn(input: Input) {
  if (input.remoteEnclave) {
    if (!input.enclaveChat) throw new Error("This model connection is unavailable on this server.");
    const reply = await input.enclaveChat(input.model ?? "", input.prompt, input.signal);
    input.throwIfInterrupted(input.signal);
    await input.append(event({ sessionId: input.session.id, turnId: input.turn.id, name: "assistant.delta", source: "provider", output: reply.answer,
      data: { delta: reply.answer, provider: input.session.provider, remoteRequestId: reply.requestId,
        remoteThreadId: reply.threadId, remoteTurnId: reply.turnId, persistentHistory: false } }));
    const completed = await input.completeTurn(input.session.id, input.turn.id, reply.turnId);
    await input.append(event({ sessionId: input.session.id, turnId: input.turn.id, name: "turn.completed", source: "provider",
      status: "completed", data: { provider: input.session.provider } }));
    return completed;
  }
  if (input.session.provider !== "openpond" || !isManagedDecisionChatModel(input.model)) return null;
  if (!input.model || input.decisionContextUnsupported)
    throw new Error("Choose a chat model for this task. Decision Models score supplied context and allowed answers.");
  return runDecisionScoringTurn({ ...input, model: input.model });
}
