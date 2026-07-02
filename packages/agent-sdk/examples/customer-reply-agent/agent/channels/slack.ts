import { defineChannel } from "openpond-agent-sdk";

export default defineChannel({
  id: "slack",
  target: { action: "chat" },
  requiredConnections: ["slack"],
  enabledByDefault: false,
  normalizeEvent(event) {
    return {
      prompt: String(event.text ?? ""),
      channel: "slack",
      threadId: typeof event.threadId === "string" ? event.threadId : null,
      context: event,
    };
  },
  renderResponse(result) {
    return { text: result.text, thread: true };
  },
});
