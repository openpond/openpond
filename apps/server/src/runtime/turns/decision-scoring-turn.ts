import type { Session, Turn, RuntimeEvent } from "@openpond/contracts";
import type { streamOpenPondHostedChatTurn } from "@openpond/runtime";
import { event } from "../../utils.js";
import { decisionChatScoreText, parseManagedDecisionChatInput } from "../../training/managed-decision-chat.js";
import { DecisionModelScoreReceiptSchema, parseAndVerifyDecisionModelScoreReceipt } from "openpond-sdk/training";
import type { TurnRunnerDependencies } from "./ports.js";

/** A Decision Model is one typed scoring operation, not an agent/tool loop.
 * Old chat context must not trigger model compaction or another paid score. */
export async function runDecisionScoringTurn(input: {
  session: Session; turn: Turn; model: string; prompt: string; signal: AbortSignal;
  stream: typeof streamOpenPondHostedChatTurn;
  append: (value: RuntimeEvent) => Promise<void>;
  updateTurn: (id: string, update: (turn: Turn) => Turn) => Promise<Turn | null>;
  completeTurn: TurnRunnerDependencies["completeTurn"];
  finalize: (id: string, outcome: "completed") => Promise<void>;
}) {
  const payload = parseManagedDecisionChatInput(input.prompt);
  const providerTurnId = `decision-${input.turn.id}`;
  await input.updateTurn(input.turn.id, turn => ({ ...turn, providerTurnId }));
  let response = "";
  for await (const delta of input.stream({ model: input.model, requestId: input.turn.id,
    messages: [{ role: "user", content: input.prompt }], signal: input.signal })) {
    input.signal.throwIfAborted();
    if (delta.type !== "text_delta" || !delta.text) continue;
    const raw = delta.raw as { modelId?: unknown; decisionReceipt?: unknown } | null;
    if (raw?.modelId !== input.model || response) throw new Error("The selected Decision Model returned an unexpected response.");
    const original = DecisionModelScoreReceiptSchema.parse(raw.decisionReceipt);
    const receipt = await parseAndVerifyDecisionModelScoreReceipt(original, { modelProjectId: original.modelProjectId,
      request: { schemaVersion: "openpond.decisionModelScoreRequest.v1", teamId: original.teamId,
        versionHash: original.version.contentHash, requestId: original.requestId, ...payload } });
    response = decisionChatScoreText(receipt);
    await input.append(event({ sessionId: input.session.id, turnId: input.turn.id,
      name: "assistant.delta", source: "provider", appId: input.session.appId, output: response,
      data: { delta: response, decisionScore: receipt },
    }));
  }
  input.signal.throwIfAborted();
  if (!response) throw new Error("The Decision Model returned no verified candidate scores.");
  await input.finalize(input.turn.id, "completed");
  await input.append(event({ sessionId: input.session.id, turnId: input.turn.id,
    name: "turn.completed", source: "provider", appId: input.session.appId,
    status: "completed", data: { providerResponse: response },
  }));
  return input.completeTurn(input.session.id, input.turn.id, providerTurnId);
}
