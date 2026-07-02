import { defineChannel } from "openpond-agent-sdk";

export default defineChannel({
  id: "openpond_chat",
  target: { action: "chat" },
  enabledByDefault: true,
  normalizeEvent(event) {
    return {
      prompt: String(event.prompt ?? event.text ?? ""),
      channel: "openpond_chat",
      context: event,
    };
  },
  renderResponse(result) {
    return { text: result.text, artifactRefs: result.artifactRefs ?? [] };
  },
});
