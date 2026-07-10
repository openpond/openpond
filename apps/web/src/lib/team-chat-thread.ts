import type { TeamChatThread } from "@openpond/contracts";

export function teamChatThreadTitle(thread: TeamChatThread, currentUserId: string | null): string {
  if (thread.kind === "general") return "# general";
  if (thread.title) return thread.title;
  const other = thread.participants.find((participant) => participant.userId !== currentUserId);
  return other?.name ?? "Direct message";
}
