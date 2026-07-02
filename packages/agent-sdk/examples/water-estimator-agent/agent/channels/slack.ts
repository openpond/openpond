import { defineChannel } from "openpond-agent-sdk";

export default defineChannel({
  id: "slack",
  target: { action: "chat" },
  requiredConnections: ["slack"],
  capabilities: ["slack.message.read", "slack.message.send", "slack.file.read", "slack.file.write"],
  normalizeEvent(event) {
    return {
      prompt: String(event.text ?? ""),
      channel: "slack",
      conversationId: stringOrNull(event.channel),
      messageId: stringOrNull(event.ts),
      threadId: stringOrNull(event.thread_ts),
      files: normalizeSlackFiles(event.files),
      context: {
        slack: event,
      },
    };
  },
  renderResponse(result) {
    return {
      text: result.text,
      thread_ts: result.metadata?.threadTs,
      artifactRefs: result.artifactRefs ?? [],
      files: result.files ?? [],
    };
  },
});

function stringOrNull(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value : null;
}

function normalizeSlackFiles(value: unknown) {
  const files = Array.isArray(value) ? value : [];
  return files.map((file, index) => ({
    ref: String((file as Record<string, unknown>).url_private ?? `slack-file-${index}`),
    name: String((file as Record<string, unknown>).name ?? "Slack file"),
    mimeType: stringOrNull((file as Record<string, unknown>).mimetype) ?? undefined,
  }));
}
