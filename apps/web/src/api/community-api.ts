import type {
  ChatAttachment,
  CommunityAttachment,
  CommunityAttachmentDownload,
  CommunityChannelMessagePage,
  CommunityDiscoveryPage,
  CommunityEventPage,
  CommunityJoinResult,
  CommunityMemberSearchResult,
  CommunityMembership,
  CommunityMessage,
  CommunityNotificationMode,
  CommunityPreview,
  CommunityRealtimeSession,
  CommunityRuleVersion,
} from "@openpond/contracts";
import { apiFetch, type ClientConnection } from "./api-client";

export const communityApi = {
  communities: (connection: ClientConnection, cursor?: string | null) => {
    const query = new URLSearchParams();
    if (cursor) query.set("cursor", cursor);
    return apiFetch<CommunityDiscoveryPage>(connection, `/v1/communities${query.size ? `?${query}` : ""}`);
  },
  communityPreview: (connection: ClientConnection, slug: string) =>
    apiFetch<CommunityPreview>(connection, `/v1/communities/${encodeURIComponent(slug)}/preview`),
  communityRules: (connection: ClientConnection, communityId: string) =>
    apiFetch<CommunityRuleVersion>(connection, `/v1/communities/${encodeURIComponent(communityId)}/rules/current`),
  joinCommunity: (connection: ClientConnection, communityId: string, acceptedRulesVersionId: string) =>
    apiFetch<CommunityJoinResult>(connection, `/v1/communities/${encodeURIComponent(communityId)}/join`, {
      method: "POST",
      body: JSON.stringify({ acceptedRulesVersionId }),
    }),
  acceptCommunityRules: (connection: ClientConnection, communityId: string, acceptedRulesVersionId: string) =>
    apiFetch<{ accepted: true }>(connection, `/v1/communities/${encodeURIComponent(communityId)}/rules/accept`, {
      method: "POST",
      body: JSON.stringify({ acceptedRulesVersionId }),
    }),
  leaveCommunity: (connection: ClientConnection, communityId: string) =>
    apiFetch<CommunityMembership>(connection, `/v1/communities/${encodeURIComponent(communityId)}/leave`, {
      method: "POST",
      body: "{}",
    }),
  communityChannels: (connection: ClientConnection, communityId: string) =>
    apiFetch<{ channels: CommunityJoinResult["channels"] }>(
      connection,
      `/v1/communities/${encodeURIComponent(communityId)}/channels`,
    ),
  communityMessages: (
    connection: ClientConnection,
    communityId: string,
    channelId: string,
    input: { beforeSequence?: number; limit?: number } = {},
  ) => {
    const query = new URLSearchParams();
    if (input.beforeSequence != null) query.set("beforeSequence", String(input.beforeSequence));
    if (input.limit != null) query.set("limit", String(input.limit));
    return apiFetch<CommunityChannelMessagePage>(
      connection,
      `/v1/communities/${encodeURIComponent(communityId)}/channels/${encodeURIComponent(channelId)}/messages${query.size ? `?${query}` : ""}`,
    );
  },
  sendCommunityMessage: (
    connection: ClientConnection,
    communityId: string,
    channelId: string,
    input: {
      body: string;
      clientRequestId: string;
      mentionUserIds?: string[];
      attachmentIds?: string[];
      replyToMessageId?: string | null;
    },
  ) => apiFetch<CommunityMessage>(
    connection,
    `/v1/communities/${encodeURIComponent(communityId)}/channels/${encodeURIComponent(channelId)}/messages`,
    { method: "POST", body: JSON.stringify(input) },
  ),
  editCommunityMessage: (
    connection: ClientConnection,
    communityId: string,
    channelId: string,
    messageId: string,
    body: string,
  ) => apiFetch<CommunityMessage>(
    connection,
    `/v1/communities/${encodeURIComponent(communityId)}/channels/${encodeURIComponent(channelId)}/messages/${encodeURIComponent(messageId)}`,
    { method: "PATCH", body: JSON.stringify({ body }) },
  ),
  deleteCommunityMessage: (
    connection: ClientConnection,
    communityId: string,
    channelId: string,
    messageId: string,
  ) => apiFetch<CommunityMessage>(
    connection,
    `/v1/communities/${encodeURIComponent(communityId)}/channels/${encodeURIComponent(channelId)}/messages/${encodeURIComponent(messageId)}`,
    { method: "DELETE", body: "{}" },
  ),
  markCommunityRead: (
    connection: ClientConnection,
    communityId: string,
    channelId: string,
    sequence: number,
  ) => apiFetch<{ sequence: number }>(
    connection,
    `/v1/communities/${encodeURIComponent(communityId)}/channels/${encodeURIComponent(channelId)}/read`,
    { method: "POST", body: JSON.stringify({ sequence }) },
  ),
  setCommunityChannelMuted: (
    connection: ClientConnection,
    communityId: string,
    channelId: string,
    muted: boolean,
  ) => apiFetch<{ channelId: string; mutedAt: string | null }>(
    connection,
    `/v1/communities/${encodeURIComponent(communityId)}/channels/${encodeURIComponent(channelId)}/mute`,
    { method: "POST", body: JSON.stringify({ muted }) },
  ),
  searchCommunityMembers: (
    connection: ClientConnection,
    communityId: string,
    input: { query?: string; cursor?: string | null; limit?: number } = {},
  ) => {
    const query = new URLSearchParams();
    if (input.query) query.set("query", input.query);
    if (input.cursor) query.set("cursor", input.cursor);
    if (input.limit != null) query.set("limit", String(input.limit));
    return apiFetch<CommunityMemberSearchResult>(
      connection,
      `/v1/communities/${encodeURIComponent(communityId)}/members/search${query.size ? `?${query}` : ""}`,
    );
  },
  updateCommunityNotifications: (
    connection: ClientConnection,
    communityId: string,
    mode: CommunityNotificationMode,
  ) => apiFetch<CommunityMembership>(
    connection,
    `/v1/communities/${encodeURIComponent(communityId)}/notifications`,
    { method: "POST", body: JSON.stringify({ mode }) },
  ),
  communityEvents: (
    connection: ClientConnection,
    communityId: string,
    input: { after?: number; limit?: number } = {},
  ) => {
    const query = new URLSearchParams();
    if (input.after != null) query.set("after", String(input.after));
    if (input.limit != null) query.set("limit", String(input.limit));
    return apiFetch<CommunityEventPage>(
      connection,
      `/v1/communities/${encodeURIComponent(communityId)}/events${query.size ? `?${query}` : ""}`,
    );
  },
  communityRealtimeSession: (connection: ClientConnection, communityId: string) =>
    apiFetch<CommunityRealtimeSession>(
      connection,
      `/v1/communities/${encodeURIComponent(communityId)}/realtime-session`,
    ),
  uploadCommunityAttachment: (
    connection: ClientConnection,
    communityId: string,
    channelId: string,
    attachment: ChatAttachment,
  ) => apiFetch<CommunityAttachment>(
    connection,
    `/v1/communities/${encodeURIComponent(communityId)}/channels/${encodeURIComponent(channelId)}/attachments/upload`,
    { method: "POST", body: JSON.stringify({ attachment }) },
  ),
  communityAttachmentDownload: (
    connection: ClientConnection,
    communityId: string,
    channelId: string,
    attachmentId: string,
  ) => apiFetch<CommunityAttachmentDownload>(
    connection,
    `/v1/communities/${encodeURIComponent(communityId)}/channels/${encodeURIComponent(channelId)}/attachments/${encodeURIComponent(attachmentId)}/download`,
  ),
};
