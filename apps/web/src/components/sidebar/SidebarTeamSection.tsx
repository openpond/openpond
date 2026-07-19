import type { TeamChatMember, TeamChatThread } from "@openpond/contracts";
import { useState } from "react";
import "../../styles/sidebar/team-sidebar.css";
import type { AppView } from "../../lib/app-models";
import type { OpenPondOrganization } from "../../lib/organization-types";
import { BellOff, ChevronDown, ChevronRight } from "../icons";
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
  const [collapsed, setCollapsed] = useState(false);
  const [teamExpanded, setTeamExpanded] = useState(true);
  if (!enabled) return null;

  const generalThread = threads.find((thread) => thread.kind === "general") ?? null;
  const dmThreadByUserId = new Map<string, TeamChatThread>();
  for (const thread of threads) {
    if (thread.kind !== "dm") continue;
    const other = thread.participants.find((participant) => participant.userId !== currentUserId);
    if (other) dmThreadByUserId.set(other.userId, thread);
  }
  const accessState = organization?.effectiveAccessState;
  const teamLabel = organization?.displayName ?? "Team";
  return (
    <div className="team-sidebar-section">
      <SidebarSection
        label="Your Team"
        collapsed={collapsed}
        onToggleCollapsed={() => setCollapsed((value) => !value)}
      >
        <div className="team-sidebar-group">
          <button
            type="button"
            className="team-sidebar-row team-sidebar-group-toggle"
            aria-label={`${teamExpanded ? "Collapse" : "Expand"} ${teamLabel}`}
            aria-expanded={teamExpanded}
            aria-controls="team-sidebar-conversations"
            onClick={() => setTeamExpanded((value) => !value)}
          >
            <span className="team-sidebar-avatar fallback">{initials(teamLabel)}</span>
            <span className="team-sidebar-group-title">
              <span className="team-sidebar-label">{teamLabel}</span>
              <span className="team-sidebar-group-chevron" aria-hidden="true">
                {teamExpanded ? <ChevronDown size={13} /> : <ChevronRight size={13} />}
              </span>
            </span>
          </button>
          {teamExpanded ? (
            <div className="team-sidebar-conversations" id="team-sidebar-conversations">
              {accessState && accessState !== "active" ? (
                <div className="team-sidebar-workspace-meta">
                  <span>{teamAccessLabel(accessState)}</span>
                </div>
              ) : null}
              {generalThread ? (
                <TeamSidebarRow
                  label="general"
                  selected={view === "team" && selectedTeamThreadId === generalThread.id}
                  muted={Boolean(generalThread.mutedAt)}
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
                      muted={Boolean(thread?.mutedAt)}
                      unreadCount={thread?.unreadCount ?? 0}
                      onSelect={() => openTeamDm(member.userId)}
                    />
                  );
                })}
              {!generalThread && members.length === 0 ? (
                <div className="empty-row">{loading ? "Loading team..." : "Team unavailable"}</div>
              ) : null}
            </div>
          ) : null}
        </div>
      </SidebarSection>
    </div>
  );
}

function TeamSidebarRow({
  label,
  member,
  selected,
  muted,
  unreadCount,
  onSelect,
}: {
  label: string;
  member?: TeamChatMember;
  selected: boolean;
  muted: boolean;
  unreadCount: number;
  onSelect: () => void;
}) {
  return (
    <button type="button" className={`team-sidebar-row${selected ? " selected" : ""}`} onClick={onSelect}>
      {member ? <TeamSidebarAvatar member={member} /> : <span className="team-sidebar-channel">#</span>}
      <span className="team-sidebar-label">{label}</span>
      <span className="team-sidebar-row-meta">
        {muted ? <BellOff size={11} aria-label="Muted" /> : null}
        {unreadCount > 0 ? (
          <span className="team-sidebar-unread" aria-label={`${unreadCount} unread`}>
            {unreadCount > 99 ? "99+" : unreadCount}
          </span>
        ) : null}
      </span>
    </button>
  );
}

function TeamSidebarAvatar({ member }: { member: TeamChatMember }) {
  if (member.image) return <img className="team-sidebar-avatar" src={member.image} alt="" />;
  return <span className="team-sidebar-avatar fallback">{initials(member.name)}</span>;
}

function initials(value: string): string {
  return value.split(/\s+/).slice(0, 2).map((part) => part[0]?.toUpperCase() ?? "").join("") || "?";
}

function teamAccessLabel(state: NonNullable<OpenPondOrganization["effectiveAccessState"]>): string {
  if (state === "checkout_pending") return "Checkout pending";
  return state.charAt(0).toUpperCase() + state.slice(1);
}
