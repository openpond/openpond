import type { ChatProvider } from "@openpond/contracts";
import { ConversationSourceIcon } from "../sidebar/ConversationSourceIcon";
import { Fragment } from "react";
import type { ActivityItem, ChatMessage } from "../../lib/app-models";
import { ConversationPeerLink, type ConversationPeer, type ConversationPeerLinkProps } from "./ConversationPeerLink";

type Props = Omit<ConversationPeerLinkProps, "peer"> & {
  activities: ActivityItem[];
  messages: readonly ChatMessage[];
  createdOnly?: boolean;
  onToggle?: () => void;
  expanded?: boolean;
  controls?: string;
};

export function createdAgentPeers(activities: ActivityItem[]): ConversationPeer[] {
  const peers = new Map<string, ConversationPeer>();
  for (const activity of activities) {
    if (!activity.startedAgent || (activity.action === "openpond_start_agent" && activity.state !== "completed")) continue;
    const sessionId = activity.openSession?.sessionId ?? "";
    peers.set(sessionId || activity.startedAgent, {sessionId, title:activity.startedAgent, provider:activity.startedAgentProvider ?? ""});
  }
  return [...peers.values()];
}

/** Names are real controls, kept outside the disclosure button. */
export function ActivityAgentLinks({activities, messages, createdOnly = false, onToggle, expanded, controls, ...links}: Props) {
  const created = createdAgentPeers(activities);
  for (const peer of created) {
    const receipt = messages.map(message => message.taskMessage ?? message.taskMessagePresentation).find(receipt => receipt?.peer.sessionId === peer.sessionId);
    if (!peer.provider && receipt) peer.provider = receipt.peer.provider;
  }
  const createdSessionIds = new Set(created.map(peer => peer.sessionId).filter(Boolean));
  const peers = {sent: new Map<string, ConversationPeer>(), received: new Map<string, ConversationPeer>()};
  for (const message of messages) {
    const receipt = message.taskMessage ?? message.taskMessagePresentation;
    if (receipt) {
      const peer: ConversationPeer = receipt.peer;
      if (receipt.direction === "sent" && createdSessionIds.has(peer.sessionId)) continue;
      peers[receipt.direction].set(peer.sessionId || peer.bindingId || peer.title, peer);
    }
  }
  const list = (values: ConversationPeer[], showIcon = false) => values.map((peer, index) => <Fragment key={peer.sessionId || peer.title}>
    {index ? index === values.length - 1 ? " and " : ", " : ""}
    <ConversationPeerLink {...links} peer={peer} showIcon={showIcon}/>
  </Fragment>);
  if (createdOnly) return <>{created.map(peer => <div className="activity-created-agents" key={peer.sessionId || peer.title}>
    <ConversationSourceIcon session={{provider:peer.provider as ChatProvider}}/>
    <ConversationPeerLink {...links} peer={peer}/>
    <span>started</span>
  </div>)}</>;
  return <>
    {peers.sent.size ? <>, <button type="button" className="activity-summary-label-toggle" aria-expanded={expanded}
      aria-controls={controls} onClick={onToggle}>sent to</button> {list([...peers.sent.values()])}</> : null}
    {peers.received.size ? <>, <button type="button" className="activity-summary-label-toggle" aria-expanded={expanded}
      aria-controls={controls} onClick={onToggle}>received from</button> {list([...peers.received.values()])}</> : null}
  </>;
}
