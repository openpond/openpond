import type { TeamChatMember, TeamChatThread } from "@openpond/contracts";
import "../../styles/sidebar/team-sidebar.css";
import type { AppView } from "../../lib/app-models";
import type { OpenPondOrganization } from "../../lib/organization-types";
import { SidebarSection } from "./SidebarRows";

type SidebarTeamSectionProps = {
  currentUserId: string | null;
  enabled: boolean;
  loading: boolean;
  members: TeamChatMember[];
  openTeamDm: (userId: string) => void;
  organization: OpenPondOrganization | null;
  selectedTeamThreadId: string | null;
  selectTeamThread: (threadId: string) => void;
  threads: TeamChatThread[];
  view: AppView;
};

export function SidebarTeamSection({
  currentUserId,
  enabled,
  loading,
  members,
  openTeamDm,
  organization,
  selectedTeamThreadId,
  selectTeamThread,
  threads,
  view,
}: SidebarTeamSectionProps) {
  if (!enabled) return null;

  const generalThread = threads.find((thread) => thread.kind === "general") ?? null;
  const dmThreadByUserId = new Map<string, TeamChatThread>();
  for (const thread of threads) {
    if (thread.kind !== "dm") continue;
    const other = thread.participants.find((participant) => participant.userId !== currentUserId);
    if (other) dmThreadByUserId.set(other.userId, thread);
  }
  const accessState = organization?.effectiveAccessState;

  return (
    <div className="team-sidebar-section">
      <SidebarSection label={organization?.displayName ?? "Team"}>
        {accessState && accessState !== "active" ? (
          <div className="team-sidebar-workspace-meta">
            <span>{teamAccessLabel(accessState)}</span>
          </div>
        ) : null}
        {generalThread ? (
          <TeamSidebarRow
            label="general"
            selected={view === "team" && selectedTeamThreadId === generalThread.id}
            unreadCount={generalThread.unreadCount}
            onSelect={() => selectTeamThread(generalThread.id)}
          />
        ) : null}
        {members
          .filter((member) => member.userId !== currentUserId)
          .map((member) => {
            const thread = dmThreadByUserId.get(member.userId) ?? null;
            return (
              <TeamSidebarRow
                key={member.userId}
                member={member}
                label={member.name}
                selected={view === "team" && selectedTeamThreadId === thread?.id}
                unreadCount={thread?.unreadCount ?? 0}
                onSelect={() => openTeamDm(member.userId)}
              />
            );
          })}
        {!generalThread && members.length === 0 ? (
          <div className="empty-row">{loading ? "Loading team..." : "Team unavailable"}</div>
        ) : null}
      </SidebarSection>
    </div>
  );
}

function TeamSidebarRow({
  label,
  member,
  selected,
  unreadCount,
  onSelect,
}: {
  label: string;
  member?: TeamChatMember;
  selected: boolean;
  unreadCount: number;
  onSelect: () => void;
}) {
  return (
    <button type="button" className={`team-sidebar-row${selected ? " selected" : ""}`} onClick={onSelect}>
      {member ? <TeamSidebarAvatar member={member} /> : <span className="team-sidebar-channel">#</span>}
      <span className="team-sidebar-label">{label}</span>
      {unreadCount > 0 ? (
        <span className="team-sidebar-unread" aria-label={`${unreadCount} unread`}>
          {unreadCount > 99 ? "99+" : unreadCount}
        </span>
      ) : null}
    </button>
  );
}

function TeamSidebarAvatar({ member }: { member: TeamChatMember }) {
  if (member.image) return <img className="team-sidebar-avatar" src={member.image} alt="" />;
  const initials = member.name
    .split(/\s+/)
    .slice(0, 2)
    .map((part) => part[0]?.toUpperCase() ?? "")
    .join("");
  return <span className="team-sidebar-avatar fallback">{initials || "?"}</span>;
}

function teamAccessLabel(state: NonNullable<OpenPondOrganization["effectiveAccessState"]>): string {
  if (state === "checkout_pending") return "Checkout pending";
  return state.charAt(0).toUpperCase() + state.slice(1);
}
