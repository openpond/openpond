import type { RuntimeEvent } from "@openpond/contracts";
import type { ChatMessage } from "./app-models";
import { buildChatMessages } from "./chat-messages";

export type IncrementalChatProjection = {
  events: RuntimeEvent[];
  messages: ChatMessage[];
};

const EMPTY_PROJECTION: IncrementalChatProjection = Object.freeze({
  events: [],
  messages: [],
});

export class IncrementalChatProjector {
  private projection: IncrementalChatProjection = EMPTY_PROJECTION;

  project(events: RuntimeEvent[]): ChatMessage[] {
    if (events === this.projection.events) return this.projection.messages;
    if (!isAppendOnly(this.projection.events, events)) {
      return this.replace(events);
    }
    const appendedEvents = events.slice(this.projection.events.length);
    if (appendedEvents.length === 0) {
      this.projection = { events, messages: this.projection.messages };
      return this.projection.messages;
    }

    const deltaProjection = appendTextDeltas(this.projection.messages, appendedEvents);
    if (deltaProjection) {
      this.projection = { events, messages: deltaProjection };
      return deltaProjection;
    }

    const boundary = incrementalReplayBoundary(events, this.projection.events.length);
    if (!boundary) return this.replace(events);
    const suffixEvents = events.slice(boundary.eventIndex);
    const suffixTurnIds = new Set(
      suffixEvents.flatMap((event) => event.turnId ? [event.turnId] : []),
    );
    const prefixMessages = this.projection.messages.filter(
      (message) => !message.turnId || !suffixTurnIds.has(message.turnId),
    );
    const messages = [...prefixMessages, ...buildChatMessages(suffixEvents)];
    this.projection = { events, messages };
    return messages;
  }

  reset(): void {
    this.projection = EMPTY_PROJECTION;
  }

  snapshot(): IncrementalChatProjection {
    return this.projection;
  }

  private replace(events: RuntimeEvent[]): ChatMessage[] {
    const messages = buildChatMessages(events);
    this.projection = { events, messages };
    return messages;
  }
}

function appendTextDeltas(
  messages: ChatMessage[],
  events: readonly RuntimeEvent[],
): ChatMessage[] | null {
  if (events.length === 0 || messages.length === 0) return null;
  const previous = messages[messages.length - 1];
  if (
    previous?.role !== "assistant" ||
    previous.createImproveRun ||
    events.some((event) =>
      (event.name !== "assistant.delta" && event.name !== "assistant.reasoning.delta") ||
      event.turnId !== previous.turnId ||
      !event.output
    )
  ) {
    return null;
  }

  let content = previous.content;
  let reasoningContent = previous.reasoningContent;
  let timestamp = previous.timestamp;
  let contentChanged = false;
  let reasoningChanged = false;
  for (const event of events) {
    if (event.name === "assistant.delta") {
      content = `${content ?? ""}${event.output}`;
      contentChanged = true;
    } else {
      reasoningContent = `${reasoningContent ?? ""}${event.output}`;
      reasoningChanged = true;
    }
    timestamp = event.timestamp;
  }
  const nextMessage: ChatMessage = {
    ...previous,
    ...(contentChanged ? { content } : {}),
    ...(reasoningChanged ? { reasoningContent } : {}),
    timestamp,
  };
  return [...messages.slice(0, -1), nextMessage];
}

function incrementalReplayBoundary(
  events: readonly RuntimeEvent[],
  previousLength: number,
): { eventIndex: number } | null {
  const firstAppended = events[previousLength];
  if (!firstAppended?.turnId) return null;
  const firstAffectedTurnIndex = events.findIndex(
    (event) => event.turnId === firstAppended.turnId,
  );
  if (firstAffectedTurnIndex < 0) return null;
  return { eventIndex: firstAffectedTurnIndex };
}

function isAppendOnly(previous: readonly RuntimeEvent[], next: readonly RuntimeEvent[]): boolean {
  if (previous.length === 0) return true;
  if (previous.length >= next.length) return false;
  return previous[0] === next[0] && previous[previous.length - 1] === next[previous.length - 1];
}
