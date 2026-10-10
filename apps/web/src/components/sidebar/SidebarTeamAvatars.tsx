import { useState } from "react";
import type { TeamChatMember } from "@openpond/contracts";
import { DropdownSelect } from "../DropdownSelect";
import "../../styles/sidebar/team-avatars.css";

export function SidebarTeamAvatars({
  members,
  currentUserId,
  teamName,
  onOpenDm,
}: {
  members: TeamChatMember[];
  currentUserId: string | null;
  teamName: string;
  onOpenDm: (userId: string) => void;
}) {
  if (!members.length) return null;
  const orderedMembers = [...members].sort((left, right) =>
    Number(left.userId === currentUserId) - Number(right.userId === currentUserId)
      || left.name.localeCompare(right.name)
      || left.userId.localeCompare(right.userId),
  );
  const remaining = Math.max(0, members.length - 3);
  return (
    <DropdownSelect
      className="sidebar-team-avatars"
      compact
      floating
      floatingMenuWidth={240}
      floatingMenuMaxHeight={228}
      openOnHover
      label={`${teamName} team members`}
      value=""
      triggerContent={
        <span className="sidebar-team-avatar-stack" aria-hidden="true">
          {orderedMembers.slice(0, 3).map((member) => (
            <MemberAvatar key={member.userId} member={member} />
          ))}
          {remaining > 0 ? <span className="sidebar-team-avatar-more">+{remaining}</span> : null}
        </span>
      }
      options={orderedMembers.map((member) => ({
        value: member.userId,
        label: member.userId === currentUserId ? `${member.name} (you)` : member.name,
        description: member.userId === currentUserId
          ? "You"
          : member.handle ? `@${member.handle.replace(/^@/, "")} · Message` : "Message",
        disabled: member.userId === currentUserId,
      }))}
      onChange={(userId) => {
        if (userId !== currentUserId && members.some((member) => member.userId === userId)) {
          onOpenDm(userId);
        }
      }}
    />
  );
}

function MemberAvatar({ member }: { member: TeamChatMember }) {
  const [failedImage, setFailedImage] = useState<string | null>(null);
  const initials = (member.name.trim() || member.handle || "?")
    .split(/\s+/).slice(0, 2).map((part) => Array.from(part)[0]?.toUpperCase() ?? "").join("");
  return (
    <span className="sidebar-team-avatar">
      {member.image && member.image !== failedImage
        ? <img src={member.image} alt="" onError={() => setFailedImage(member.image)} />
        : initials}
    </span>
  );
}
