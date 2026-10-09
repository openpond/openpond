import type { RuntimeEvent } from "@openpond/contracts";
import type { ChatMessage } from "./app-models";
import { asRecord } from "./chat-message-utils";

export type NativeAssistantMessage = { message: ChatMessage; finalized: boolean };

/** Show native commentary as text while keeping it addressable for replacement
 * by the authoritative final answer. Actual thinking remains separate. */
export function appendNativeAssistantMessage(
  messages: ChatMessage[],
  byId: Map<string, NativeAssistantMessage>,
  item: RuntimeEvent,
): ChatMessage | null {
  const data = asRecord(item.data);
  const final = item.name === "assistant.delta" && data?.phase === "final_answer" && data.nativeMessageSnapshot === true;
  const progress = (item.name === "assistant.delta" || item.name === "assistant.reasoning.delta") && (data?.phase === "commentary" || data?.phase === "reasoning");
  if ((!final && !progress) || typeof data?.nativeMessageId !== "string" || !item.output) return null;
  const id = data.nativeMessageId;
  let entry = byId.get(id);
  if (!entry) {
    entry = { message: { id, role: "assistant", turnId: item.turnId, timestamp: item.timestamp }, finalized: false };
    byId.set(id, entry);
    messages.push(entry.message);
  }
  const { message } = entry;
  if (final) {
    entry.finalized = true;
    message.content = item.output;
    delete message.reasoningContent;
    const index = messages.indexOf(message);
    if (index !== messages.length - 1) {
      messages.splice(index, 1);
      messages.push(message);
    }
  } else if (!entry.finalized) {
    if (data.phase === "commentary") message.content = `${message.content ?? ""}${item.output}`;
    else message.reasoningContent = `${message.reasoningContent ?? ""}${item.output}`;
  }
  message.timestamp = item.timestamp;
  return message;
}
