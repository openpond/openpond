import { defineChannel } from "openpond-agent-sdk";

export default defineChannel({
  id: "mcp",
  target: { action: "chat" },
  normalizeEvent(event) {
    return {
      prompt: String(event.prompt ?? event.arguments ?? ""),
      channel: "mcp",
      conversationId: stringOrNull(event.sessionId),
      messageId: stringOrNull(event.requestId),
      files: normalizeFiles(event.files),
      context: {
        mcp: event,
      },
    };
  },
  renderResponse(result) {
    return {
      content: [{ type: "text", text: result.text }],
      artifactRefs: result.artifactRefs ?? [],
      structuredContent: result.metadata ?? {},
    };
  },
});

function stringOrNull(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value : null;
}

function normalizeFiles(value: unknown) {
  return Array.isArray(value) ? value : [];
}
