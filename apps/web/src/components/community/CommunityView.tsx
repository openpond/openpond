import type { CommunityMessage, CommunityNotificationMode } from "@openpond/contracts";
import { useEffect, useMemo, useRef, useState } from "react";
import type { useCommunities } from "../../hooks/useCommunities";
import type { useCommunityChat } from "../../hooks/useCommunityChat";
import { Bell, BellOff, RefreshCw, ScrollText, UserRound, WifiOff } from "../icons";
import { CommunityComposer } from "./CommunityComposer";
import { CommunityMessageRow } from "./CommunityMessageRow";
import { CommunityRulesDialog } from "./CommunityRulesDialog";
import "../../styles/community/community.css";

export type CommunityViewProps = {
  communities: ReturnType<typeof useCommunities>;
  chat: ReturnType<typeof useCommunityChat>;
  currentUserId: string | null;
};

export function CommunityView({ communities, chat, currentUserId }: CommunityViewProps) {
  const [rulesMode, setRulesMode] = useState<"join" | "reaccept" | "review" | null>(null);
  const [replyTo, setReplyTo] = useState<CommunityMessage | null>(null);
  const messagesRef = useRef<HTMLDivElement | null>(null);
  const preview = communities.preview;
  const memberActive = preview?.membership?.status === "active";
  const requiresAcceptance = Boolean(preview?.capabilities.requiresRulesAcceptance);
  const membersById = useMemo(() => new Map(chat.members.map((member) => [member.userId, member])), [chat.members]);
  const messagesById = useMemo(() => new Map(chat.messages.map((message) => [message.id, message])), [chat.messages]);
  const lastSequence = chat.messages.at(-1)?.sequence ?? 0;

  useEffect(() => {
    const element = messagesRef.current;
    if (element) element.scrollTop = element.scrollHeight;
  }, [chat.selectedChannelId, lastSequence]);

  useEffect(() => {
    setReplyTo(null);
    if (requiresAcceptance && preview?.currentRules) setRulesMode("reaccept");
  }, [preview?.currentRules, requiresAcceptance]);

  if (!communities.selectedSummary) {
    return (
      <section className="community-empty-page">
        <div className="community-discovery-card">
          <UserRound size={30} />
          <h1>Discover communities</h1>
          <p>{communities.discoveryLoading && communities.items.length === 0 ? "Finding communities…" : "Preview public conversations and join after accepting each community's rules."}</p>
          {communities.discoveryError ? <div className="community-state error">{communities.discoveryError}</div> : null}
          {communities.items.length > 0 ? (
            <div className="community-discovery-list">
              {communities.items.map((community) => (
                <button type="button" key={community.id} onClick={() => communities.selectCommunity(community.id)}>
                  <CommunityIcon name={community.displayName} imageUrl={community.imageUrl} />
                  <span><strong>{community.displayName}</strong><small>{community.description}</small></span>
                  <em>{community.membership?.status === "active" ? "Joined" : community.featuredAt ? "Featured" : `${community.memberCount.toLocaleString()} members`}</em>
                </button>
              ))}
            </div>
          ) : !communities.discoveryLoading ? <div className="community-state">No public communities are available yet.</div> : null}
          <div className="community-discovery-actions">
            <button type="button" onClick={() => void communities.refresh()} disabled={communities.discoveryLoading}><RefreshCw size={14} /> Refresh</button>
            {communities.nextCursor ? <button type="button" className="secondary" onClick={() => void communities.loadMore()} disabled={communities.discoveryLoading}>Load more</button> : null}
          </div>
        </div>
      </section>
    );
  }

  if (!preview && communities.previewLoading) {
    return <section className="community-empty-page"><div className="community-empty-card"><span className="community-spinner" /> Loading community…</div></section>;
  }

  if (!preview) {
    return (
      <section className="community-empty-page">
        <div className="community-empty-card">
          <h1>{communities.selectedSummary.displayName}</h1>
          <div className="community-state error">{communities.previewError ?? "This community preview is unavailable."}</div>
          <button type="button" onClick={() => communities.selectCommunity(communities.selectedSummary!.id)}><RefreshCw size={14} /> Retry preview</button>
        </div>
      </section>
    );
  }

  const activeRules = preview.currentRules;
  const membershipError = communities.membershipError?.message ?? null;
  return (
    <section className="community-view">
      <header className="community-header">
        <div className="community-heading">
          <CommunityIcon name={preview.displayName} imageUrl={preview.imageUrl} />
          <div>
            <small>{preview.displayName}</small>
            <h1>{chat.selectedChannel ? `# ${chat.selectedChannel.displayName}` : preview.displayName}</h1>
            <p>{chat.selectedChannel?.topic || preview.description}</p>
          </div>
        </div>
        <div className="community-header-actions">
          <span className="community-member-count"><UserRound size={14} /> {preview.memberCount.toLocaleString()}</span>
          {activeRules ? <button type="button" className="secondary" onClick={() => setRulesMode("review")}><ScrollText size={14} /> Rules</button> : null}
          {memberActive ? (
            <CommunityMembershipMenu
              mode={preview.membership?.notificationMode ?? "mentions"}
              busy={communities.membershipBusy}
              onMode={communities.updateNotifications}
              onLeave={communities.leave}
            />
          ) : null}
        </div>
      </header>

      <div className="community-chat-main conversation-surface-main">
        <div className="community-chat-notices">
          {!memberActive ? (
            <div className="community-preview-banner">
              <div><strong>Previewing {preview.displayName}</strong><span>Read the public conversation, then accept the rules to join and post.</span></div>
              <button type="button" disabled={!activeRules || communities.membershipBusy} onClick={() => setRulesMode("join")}>Join community</button>
            </div>
          ) : requiresAcceptance ? (
            <div className="community-preview-banner warning">
              <div><strong>The rules have changed</strong><span>Accept the current rules to continue reading live updates and posting.</span></div>
              <button type="button" disabled={!activeRules || communities.membershipBusy} onClick={() => setRulesMode("reaccept")}>Review updated rules</button>
            </div>
          ) : null}

          {chat.realtimeError && memberActive && !requiresAcceptance ? (
            <div className="community-realtime-state"><WifiOff size={14} /><span>Live updates are reconnecting. Loaded messages are still available.</span></div>
          ) : null}
          {chat.lostMembership ? <div className="community-state error">Your membership changed. Refresh the community before continuing.</div> : null}
          {chat.channelsError ? <div className="community-state error">Channels: {chat.channelsError} <button type="button" onClick={() => void chat.loadChannels()}>Retry</button></div> : null}
          {membershipError ? <div className="community-state error" role="alert">{membershipError}</div> : null}
        </div>

        <div
          className="community-message-pane conversation-message-scroll"
          ref={messagesRef}
          role="log"
          aria-live="polite"
          aria-relevant="additions text"
          aria-busy={chat.messagesLoading}
          aria-label={chat.selectedChannel ? `${preview.displayName}, ${chat.selectedChannel.displayName}` : preview.displayName}
          tabIndex={0}
        >
          {chat.hasMoreBefore ? <button type="button" className="community-load-older" disabled={chat.olderMessagesLoading} onClick={() => void chat.loadOlder()}>{chat.olderMessagesLoading ? "Loading…" : "Load earlier messages"}</button> : null}
          {chat.messagesLoading && chat.messages.length === 0 ? <div className="community-message-state">Loading messages…</div> : null}
          {chat.messagesError ? <div className="community-message-state error">Could not load messages: {chat.messagesError} <button type="button" onClick={() => void chat.loadMessages()}>Retry</button></div> : null}
          {!chat.messagesLoading && !chat.messagesError && chat.messages.length === 0 ? <div className="community-message-state">No messages in this channel yet.</div> : null}
          {chat.messages.map((message) => (
            <CommunityMessageRow
              key={message.id}
              message={message}
              author={message.authorUserId ? membersById.get(message.authorUserId) ?? null : null}
              own={message.authorUserId === currentUserId}
              attachmentsAccessible={!chat.previewMode}
              membersById={membersById}
              messagesById={messagesById}
              onReply={setReplyTo}
              onEdit={chat.editMessage}
              onDelete={chat.deleteMessage}
              onDownloadAttachment={chat.downloadAttachment}
            />
          ))}
        </div>

        {memberActive ? (
          <div className="community-composer-wrap conversation-composer-shell">
            {chat.actionError ? <div className="community-composer-action-error">{chat.actionError}</div> : null}
            {chat.failedSend ? (
              <div className="community-failed-send">
                <span>Message not sent. {chat.failedSend.message}</span>
                <button type="button" disabled={chat.sending} onClick={() => void chat.retrySend()}>Retry</button>
                <button type="button" onClick={chat.dismissFailedSend}>Dismiss</button>
              </div>
            ) : null}
            <CommunityComposer
              members={chat.members}
              replyTo={replyTo}
              busy={chat.sending}
              disabled={requiresAcceptance || chat.lostMembership || !chat.selectedChannel || chat.selectedChannel.postingPolicy === "admins" && preview.membership?.role === "member"}
              onCancelReply={() => setReplyTo(null)}
              onSearchMembers={chat.searchMembers}
              onSend={chat.sendMessage}
            />
          </div>
        ) : null}
      </div>

      {rulesMode && activeRules ? (
        <CommunityRulesDialog
          rules={activeRules}
          mode={rulesMode}
          busy={communities.membershipBusy}
          error={membershipError}
          onAccept={rulesMode === "join" ? communities.join : communities.acceptRules}
          onClose={() => setRulesMode(null)}
        />
      ) : null}
    </section>
  );
}

function CommunityMembershipMenu(props: {
  mode: CommunityNotificationMode;
  busy: boolean;
  onMode: (mode: CommunityNotificationMode) => Promise<boolean>;
  onLeave: () => Promise<boolean>;
}) {
  const [open, setOpen] = useState(false);
  return (
    <div className="community-membership-menu">
      <button type="button" className="secondary" aria-expanded={open} onClick={() => setOpen((value) => !value)}>
        {props.mode === "none" ? <BellOff size={14} /> : <Bell size={14} />} Joined
      </button>
      {open ? (
        <div className="community-membership-popover">
          <strong>Notifications</strong>
          {(["mentions", "all", "none"] as const).map((mode) => (
            <label key={mode}><input type="radio" name="community-notifications" checked={props.mode === mode} disabled={props.busy} onChange={() => void props.onMode(mode)} /> {mode === "mentions" ? "Mentions" : mode === "all" ? "All messages" : "Nothing"}</label>
          ))}
          <button type="button" className="danger" disabled={props.busy} onClick={() => {
            if (!window.confirm("Leave this community? You can join again later by accepting the current rules.")) return;
            void props.onLeave().then((left) => { if (left) setOpen(false); });
          }}>Leave community</button>
        </div>
      ) : null}
    </div>
  );
}

function CommunityIcon({ name, imageUrl }: { name: string; imageUrl: string | null }) {
  if (imageUrl) return <img className="community-icon" src={imageUrl} alt="" />;
  return <span className="community-icon fallback">{name.slice(0, 2).toUpperCase()}</span>;
}
