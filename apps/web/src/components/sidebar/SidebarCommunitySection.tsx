import type { CommunityChannel, CommunitySummary } from "@openpond/contracts";
import { useEffect, useState } from "react";
import type { AppView } from "../../lib/app-models";
import "../../styles/sidebar/community-sidebar.css";
import "../../styles/sidebar/team-sidebar.css";
import { BellOff, ChevronDown, ChevronRight, Globe2 } from "../icons";
import { SidebarSection } from "./SidebarRows";

export function SidebarCommunitySection(props: {
  communities: CommunitySummary[];
  channels: CommunityChannel[];
  loading: boolean;
  error: string | null;
  selectedCommunityId: string | null;
  selectedChannelId: string | null;
  view: AppView;
  onDiscover: () => void;
  onSelectCommunity: (communityId: string) => void;
  onSelectChannel: (channelId: string) => void;
}) {
  const [collapsed, setCollapsed] = useState(false);
  const [expandedCommunityIds, setExpandedCommunityIds] = useState<Set<string>>(
    () => new Set(props.selectedCommunityId ? [props.selectedCommunityId] : []),
  );
  const selected = props.communities.find((community) => community.id === props.selectedCommunityId) ?? null;
  const ordered = props.communities.filter((community) => (
    community.membership?.status === "active" || Boolean(community.featuredAt) || community.id === props.selectedCommunityId
  )).sort((left, right) => {
    const membership = Number(Boolean(right.membership?.status === "active")) - Number(Boolean(left.membership?.status === "active"));
    return membership || Number(Boolean(right.featuredAt)) - Number(Boolean(left.featuredAt)) || left.displayName.localeCompare(right.displayName);
  });

  useEffect(() => {
    if (!props.selectedCommunityId) return;
    setExpandedCommunityIds((current) => {
      if (current.has(props.selectedCommunityId!)) return current;
      return new Set([...current, props.selectedCommunityId!]);
    });
  }, [props.selectedCommunityId]);

  function selectOrToggleCommunity(community: CommunitySummary, active: boolean, joined: boolean) {
    if (active && joined) {
      setExpandedCommunityIds((current) => {
        const next = new Set(current);
        if (next.has(community.id)) next.delete(community.id);
        else next.add(community.id);
        return next;
      });
      return;
    }
    if (joined) {
      setExpandedCommunityIds((current) => new Set([...current, community.id]));
    }
    props.onSelectCommunity(community.id);
  }

  return (
    <div className="community-sidebar-section">
      <SidebarSection
        label="Communities"
        collapsed={collapsed}
        onToggleCollapsed={() => setCollapsed((value) => !value)}
        titleAccessory={(
          <button
            type="button"
            className={`community-sidebar-discover${props.view === "community" && !selected ? " selected" : ""}`}
            aria-label="Discover communities"
            onClick={props.onDiscover}
          >
            <Globe2 size={14} />
          </button>
        )}
      >
        {ordered.map((community) => {
          const active = community.id === props.selectedCommunityId;
          const joined = community.membership?.status === "active";
          const expanded = active && joined && expandedCommunityIds.has(community.id);
          return (
            <div key={community.id} className="community-sidebar-group">
              <button
                type="button"
                className={`team-sidebar-row community-sidebar-community${props.view === "community" && active && !props.selectedChannelId ? " selected" : ""}`}
                aria-label={joined ? `${expanded ? "Collapse" : "Expand"} ${community.displayName}` : undefined}
                aria-expanded={joined ? expanded : undefined}
                aria-controls={active && joined ? `community-sidebar-channels-${community.id}` : undefined}
                onClick={() => selectOrToggleCommunity(community, active, joined)}
              >
                {community.imageUrl ? <img className="team-sidebar-avatar" src={community.imageUrl} alt="" /> : <span className="team-sidebar-avatar community-sidebar-avatar">{community.displayName.slice(0, 2).toUpperCase()}</span>}
                <span className="team-sidebar-group-title">
                  <span className="team-sidebar-label">{community.displayName}</span>
                  {joined ? (
                    <span className="community-sidebar-group-chevron" aria-hidden="true">
                      {expanded ? <ChevronDown size={13} /> : <ChevronRight size={13} />}
                    </span>
                  ) : null}
                </span>
                {!joined && community.featuredAt ? <small>Featured</small> : null}
              </button>
              {expanded ? (
                <div className="community-sidebar-channels" id={`community-sidebar-channels-${community.id}`}>
                  {props.channels.map((channel) => (
                    <button
                      type="button"
                      key={channel.id}
                      className={`team-sidebar-row community-sidebar-channel-row${props.view === "community" && channel.id === props.selectedChannelId ? " selected" : ""}`}
                      onClick={() => props.onSelectChannel(channel.id)}
                    >
                      <span className="team-sidebar-channel" aria-hidden="true">#</span>
                      <span className="team-sidebar-label">{channel.displayName}</span>
                      <span className="team-sidebar-row-meta">
                        {channel.readState?.mutedAt ? <BellOff size={11} aria-label="Muted" /> : null}
                        {channel.unreadCount > 0 ? <span className="team-sidebar-unread" aria-label={`${channel.unreadCount} unread`}>{channel.unreadCount > 99 ? "99+" : channel.unreadCount}</span> : null}
                      </span>
                    </button>
                  ))}
                </div>
              ) : null}
            </div>
          );
        })}
        {ordered.length === 0 ? <div className="empty-row">{props.loading ? "Loading communities…" : props.error ? "Communities unavailable" : "Join or feature a community to pin it here"}</div> : null}
      </SidebarSection>
    </div>
  );
}
