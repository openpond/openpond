import { defineChannel } from "openpond-agent-sdk";

export default defineChannel({
  id: "openpond_chat",
  target: { action: "chat" },
  normalizeEvent(event) {
    return {
      prompt: String(event.prompt ?? event.message ?? ""),
      channel: "openpond_chat",
      conversationId: stringOrNull(event.conversationId),
      messageId: stringOrNull(event.messageId),
      files: normalizeFiles(event.files),
      context: event,
    };
  },
  renderResponse(result) {
    return {
      text: result.text,
      files: result.files ?? [],
      artifactRefs: result.artifactRefs ?? [],
    };
  },
});

function stringOrNull(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value : null;
}

function normalizeFiles(value: unknown) {
  return Array.isArray(value) ? value : [];
}
