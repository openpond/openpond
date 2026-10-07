import type { RuntimeEvent } from "@openpond/contracts";
import type { HostedChatContinuation, HostedChatMessage } from "@openpond/cloud";
import { hostedRequestedOutputTokens } from "../../openpond/context-usage.js";
import { event } from "../../utils.js";

/** Recover only inside the admitted turn, before dispatching any truncated tool
 * calls. Earlier successful actions stay in context; unknown model limits fail. */
export async function recoverHostedOutputLimit(input: {
  messages: HostedChatMessage[];
  response: { text: string; continuation?: HostedChatContinuation };
  maximumOutputTokens: number;
  maxContextTokens?: number | null;
  modelOutputLimit?: number | null;
  sessionId: string;
  turnId: string;
  requestId: string;
  appendRuntimeEvent(event: RuntimeEvent): Promise<unknown>;
  recordUsage(): Promise<void>;
}): Promise<number> {
  const nextOutputTokens = input.modelOutputLimit
    ? hostedRequestedOutputTokens({
        maxContextTokens: input.maxContextTokens,
        modelOutputLimit: input.modelOutputLimit,
        requestedOutputTokens: input.maximumOutputTokens * 2,
      })
    : input.maximumOutputTokens;
  await input.appendRuntimeEvent(event({
    sessionId: input.sessionId, turnId: input.turnId, name: "diagnostic",
    source: "server", status: "failed",
    output: "The provider reached its output token limit before completing the response.",
    data: { phase: "provider_output_limit", requestId: input.requestId,
      maximumOutputTokens: input.maximumOutputTokens, nextOutputTokens },
  }));
  await input.recordUsage();
  if (nextOutputTokens <= input.maximumOutputTokens)
    throw new Error(`Provider output token limit (${input.maximumOutputTokens}) exhausted; the response is incomplete.`);
  const { text, continuation } = input.response;
  if (text.trim() || continuation) input.messages.push({
    role: "assistant", content: text,
    ...(continuation ? { continuation } : {}),
  });
  input.messages.push({ role: "user", content:
    "The previous response reached its output token limit before finishing. Continue the unfinished task. No tool call from that truncated response was executed; do not repeat actions completed in earlier rounds." });
  return nextOutputTokens;
}
