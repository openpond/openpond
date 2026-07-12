import type { TeamChatMember } from "@openpond/contracts";

export function mentionedTeamMemberIds(body: string, members: TeamChatMember[]): string[] {
  const tokens = new Set(
    Array.from(body.matchAll(/(?:^|\s)@([a-zA-Z0-9_-]+)/g), (match) =>
      (match[1] ?? "").toLowerCase(),
    ),
  );
  return members
    .filter((member) => {
      const handle = member.handle?.toLowerCase();
      const normalizedName = member.name.toLowerCase().replace(/[^a-z0-9_-]+/g, "-");
      return (handle && tokens.has(handle)) || tokens.has(normalizedName);
    })
    .map((member) => member.userId);
}
