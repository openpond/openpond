import type {
  TeamChatMember,
  TeamChatMessage,
  TeamChatThread,
} from "@openpond/contracts";

export const TEAM_CHAT_NOTIFICATION_MODE_STORAGE_KEY =
  "openpond.team-chat.notification-mode";

export type TeamChatNotificationMode = "all" | "direct_mentions" | "none";

export type TeamChatIncomingNotification = {
  eventId: number;
  threadId: string;
  title: string;
  body: string;
};

export type TeamChatNotificationStorage = Pick<
  Storage,
  "getItem" | "setItem"
>;

function browserLocalStorage(): TeamChatNotificationStorage | null {
  try {
    return typeof window === "undefined" ? null : window.localStorage;
  } catch {
    return null;
  }
}

export function readTeamChatNotificationMode(
  storage: TeamChatNotificationStorage | null = browserLocalStorage(),
): TeamChatNotificationMode {
  const stored = storage?.getItem(TEAM_CHAT_NOTIFICATION_MODE_STORAGE_KEY);
  return stored === "direct_mentions" || stored === "none" ? stored : "all";
}

export function writeTeamChatNotificationMode(
  mode: TeamChatNotificationMode,
  storage: TeamChatNotificationStorage | null = browserLocalStorage(),
): void {
  try {
    storage?.setItem(TEAM_CHAT_NOTIFICATION_MODE_STORAGE_KEY, mode);
  } catch {
    // Storage can be unavailable in a privacy-restricted renderer. Session state still applies.
  }
}

export function shouldNotifyForTeamChatMessage(input: {
  mode: TeamChatNotificationMode;
  currentUserId: string | null;
  message: TeamChatMessage;
  thread: TeamChatThread | null;
}): boolean {
  if (
    input.mode === "none" ||
    !input.currentUserId ||
    !input.thread ||
    input.thread.mutedAt ||
    input.message.deletedAt ||
    input.message.authorUserId === input.currentUserId
  ) {
    return false;
  }
  if (input.mode === "all") return true;
  if (input.thread.kind === "dm") return true;
  const mentionUserIds = Array.isArray(input.message.metadata.mentionUserIds)
    ? input.message.metadata.mentionUserIds
    : [];
  return mentionUserIds.includes(input.currentUserId);
}

export function teamChatIncomingNotification(input: {
  eventId: number;
  message: TeamChatMessage;
  thread: TeamChatThread;
  members: TeamChatMember[];
}): TeamChatIncomingNotification {
  const author = input.message.authorUserId
    ? input.members.find((member) => member.userId === input.message.authorUserId)
        ?.name ?? "Team member"
    : input.message.authorType === "agent"
      ? "Agent"
      : "Team";
  const threadName = input.thread.title?.trim() ||
    (input.thread.kind === "general" ? "general" : "conversation");
  const title = input.thread.kind === "dm" ? author : `${author} in #${threadName}`;
  const text = input.message.body.replace(/\s+/g, " ").trim();
  const body = text ||
    (input.message.attachments.length === 1
      ? "Sent an image"
      : input.message.attachments.length > 1
        ? `Sent ${input.message.attachments.length} images`
        : "New message");
  return {
    eventId: input.eventId,
    threadId: input.message.threadId,
    title,
    body: body.length > 160 ? `${body.slice(0, 157)}…` : body,
  };
}
