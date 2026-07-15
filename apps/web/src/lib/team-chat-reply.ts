import type {
  TeamChatMember,
  TeamChatMessage,
  TeamChatMessageRef,
} from "@openpond/contracts";

export type TeamChatReplyTarget = {
  id: string;
  authorType: TeamChatMessage["authorType"];
  authorUserId: string | null;
  authorAgentId: string | null;
  body: string;
  deleted: boolean;
};

export function teamChatReplyRef(
  message: TeamChatMessage,
): TeamChatMessageRef | null {
  return (
    message.refs.find((ref) => ref.refType === "message_reply") ?? null
  );
}

export function teamChatReplyTargetFromMessage(
  message: TeamChatMessage,
): TeamChatReplyTarget {
  return {
    id: message.id,
    authorType: message.authorType,
    authorUserId: message.authorUserId,
    authorAgentId: message.authorAgentId,
    body: message.body,
    deleted: Boolean(message.deletedAt),
  };
}

export function teamChatReplyTargetForMessage(
  message: TeamChatMessage,
  messagesById: ReadonlyMap<string, TeamChatMessage>,
): TeamChatReplyTarget | null {
  const ref = teamChatReplyRef(message);
  if (!ref) return null;
  const liveTarget = messagesById.get(ref.refId);
  if (liveTarget) return teamChatReplyTargetFromMessage(liveTarget);
  return replyTargetFromPreview(ref);
}

export function teamChatReplyPreview(
  message: TeamChatMessage,
): Record<string, unknown> {
  const body = message.body.slice(0, 500);
  return {
    authorType: message.authorType,
    authorUserId: message.authorUserId,
    authorAgentId: message.authorAgentId,
    body,
    truncated: body.length < message.body.length,
  };
}

export function teamChatReplyAuthorLabel(
  target: TeamChatReplyTarget,
  membersById: ReadonlyMap<string, TeamChatMember>,
): string {
  if (target.authorUserId) {
    return membersById.get(target.authorUserId)?.name ?? "Team member";
  }
  if (target.authorType === "agent" || target.authorAgentId) return "Agent";
  if (target.authorType === "system") return "System";
  return "Team member";
}

export function teamChatReplySnippet(target: TeamChatReplyTarget): string {
  if (target.deleted) return "Message deleted";
  const body = target.body.replace(/\s+/g, " ").trim();
  return body || "Attachment";
}

function replyTargetFromPreview(
  ref: TeamChatMessageRef,
): TeamChatReplyTarget {
  const preview = ref.preview;
  return {
    id: ref.refId,
    authorType: authorType(preview.authorType),
    authorUserId:
      typeof preview.authorUserId === "string" ? preview.authorUserId : null,
    authorAgentId:
      typeof preview.authorAgentId === "string" ? preview.authorAgentId : null,
    body: typeof preview.body === "string" ? preview.body : "",
    deleted: preview.deleted === true,
  };
}

function authorType(value: unknown): TeamChatMessage["authorType"] {
  if (value === "agent" || value === "system") return value;
  return "user";
}
