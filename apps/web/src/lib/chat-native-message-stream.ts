import type { RuntimeEvent } from "@openpond/contracts";
import type { ChatMessage } from "./app-models";
import { asRecord } from "./chat-message-utils";

/** Keep provisional Claude text addressable until its final result identifies
 * the answer. Replaying saved events performs the same promotion as live output. */
export function appendNativeAssistantMessage(
  messages: ChatMessage[],
  byId: Map<string, ChatMessage>,
  item: RuntimeEvent,
): ChatMessage | null {
  const data = asRecord(item.data);
  const final = item.name === "assistant.delta" && data?.phase === "final_answer" && data.nativeMessageSnapshot === true;
  const progress = item.name === "assistant.reasoning.delta" && (data?.phase === "commentary" || data?.phase === "reasoning");
  if ((!final && !progress) || typeof data?.nativeMessageId !== "string" || !item.output) return null;
  const id = data.nativeMessageId;
  let message = byId.get(id);
  if (!message) {
    message = { id, role: "assistant", turnId: item.turnId, timestamp: item.timestamp };
    byId.set(id, message);
    messages.push(message);
  }
  if (final) {
    message.content = item.output;
    delete message.reasoningContent;
    const index = messages.indexOf(message);
    if (index !== messages.length - 1) {
      messages.splice(index, 1);
      messages.push(message);
    }
  } else if (message.content === undefined) {
    message.reasoningContent = `${message.reasoningContent ?? ""}${item.output}`;
  }
  message.timestamp = item.timestamp;
  return message;
}
