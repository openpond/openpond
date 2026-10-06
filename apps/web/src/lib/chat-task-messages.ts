import { TaskInputSchema, type RuntimeEvent } from "@openpond/contracts";
import type { ChatMessage } from "./app-models";
import { asRecord } from "./chat-message-utils";

/** Only durable session-qualified events can create a peer message attribution. */
export function taskMessageFromEvent(event: RuntimeEvent): ChatMessage | null {
  const data = asRecord(event.data);
  const parsed = TaskInputSchema.safeParse(data?.input);
  if (!parsed.success || !parsed.data.senderSessionId || parsed.data.senderKind === "user") return null;
  const input = parsed.data;
  const delivery = asRecord(data?.delivery);
  const sent = delivery?.direction === "sent" && event.sessionId === input.senderSessionId;
  if (!sent && event.sessionId !== input.sessionId) return null;
  const peerId = sent ? input.sessionId : input.senderSessionId!;
  const peer = asRecord(delivery?.peer);
  const identityMatches = peer?.sessionId === peerId;
  return {
    id: `task-input:${input.id}:${sent ? "sent" : "received"}`,
    role: "task_message", content: input.body, timestamp: input.createdAt,
    turnId: sent ? undefined : input.turnId ?? undefined,
    taskMessage: { input, direction: sent ? "sent" : "received", peer: {
      sessionId: peerId,
      title: identityMatches && typeof peer.title === "string" ? peer.title : "Another task",
      provider: identityMatches && typeof peer.provider === "string" ? peer.provider : "",
    } },
  };
}
