import { defineChannel } from "openpond-agent-sdk";

export default defineChannel({
  id: "microsoft_teams",
  target: { action: "chat" },
  requiredConnections: ["microsoft_teams"],
  capabilities: ["microsoft_teams.message.ingest"],
  normalizeEvent(event) {
    return {
      prompt: String(event.text ?? event.prompt ?? ""),
      channel: "microsoft_teams",
      conversationId: stringOrNull(event.conversationId),
      messageId: stringOrNull(event.activityId ?? event.messageId),
      threadId: stringOrNull(event.replyToActivityId ?? event.threadId),
      files: normalizeTeamsFiles(event.attachments),
      context: {
        teams: event,
        microsoftTeamsBotRunId: event.microsoftTeamsBotRunId,
        tenantId: event.tenantId,
        teamId: event.teamId,
        channelId: event.channelId,
      },
    };
  },
  renderResponse(result) {
    return {
      text: result.text,
      status: result.needsUserInput ? "waiting_for_user" : "completed",
      artifactRefs: result.artifactRefs ?? [],
      sharePointRefs: result.metadata?.sharePointRefs ?? [],
    };
  },
});

function stringOrNull(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value : null;
}

function normalizeTeamsFiles(value: unknown) {
  const attachments = Array.isArray(value) ? value : [];
  return attachments.map((attachment, index) => ({
    ref: String((attachment as Record<string, unknown>).contentUrl ?? `teams-attachment-${index}`),
    name: String((attachment as Record<string, unknown>).name ?? "Teams attachment"),
    mimeType: stringOrNull((attachment as Record<string, unknown>).contentType) ?? undefined,
  }));
}
