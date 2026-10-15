import type { RuntimeEvent, TaskInboxSnapshot, TaskInput } from "@openpond/contracts";
import { taskMessageFromEvent } from "./chat-task-messages";

export type ComposerInboxEntry = {
  input: TaskInput;
  direction: "sent" | "received";
  peer: string;
};

export function composerInboxEntries(sessionId: string, snapshot: TaskInboxSnapshot | null, events: readonly RuntimeEvent[]): ComposerInboxEntry[] {
  const entries = new Map<string, ComposerInboxEntry>();
  for (const event of events) {
    if (event.sessionId !== sessionId || event.name !== "task.input") continue;
    const message = taskMessageFromEvent(event)?.taskMessage;
    if (!message) continue;
    const previous = entries.get(message.input.id);
    if (!previous || previous.input.revision <= message.input.revision) {
      entries.set(message.input.id, { input: message.input, direction: message.direction, peer: message.peer.title });
    }
  }
  for (const input of snapshot?.sessionId === sessionId ? snapshot.inputs : []) {
    if (input.senderKind === "runtime" && !input.senderSessionId) continue;
    const previous = entries.get(input.id);
    if (previous && previous.input.revision > input.revision) continue;
    entries.set(input.id, { input, direction: "received", peer: previous?.peer ?? (
      input.senderKind === "ponder" ? "Ponder Pal" : input.senderKind === "user" ? "You" : input.senderSessionId ?? "Another chat"
    ) });
  }
  return [...entries.values()].sort((a, b) => b.input.createdAt.localeCompare(a.input.createdAt) || b.input.sequence - a.input.sequence);
}

export function inboxDeliveryLabel(input: TaskInput): string {
  if (input.state === "rejected" || input.error) return "Failed";
  if (input.state === "cancelled") return "Cancelled";
  if (input.state === "pending") return "Pending";
  return "Delivered";
}
