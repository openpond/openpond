import {
  ChatAttachmentSchema,
  CommunityAttachmentDownloadSchema,
  CommunityAttachmentSchema,
  CommunityAttachmentUploadSchema,
  CommunityChannelMessagePageSchema,
  CommunityChannelsResultSchema,
  CommunityDiscoveryPageSchema,
  CommunityEventPageSchema,
  CommunityJoinResultSchema,
  CommunityMemberSearchResultSchema,
  CommunityMembershipSchema,
  CommunityMessageSchema,
  CommunityNotificationModeSchema,
  CommunityPreviewSchema,
  CommunityRealtimeSessionSchema,
  CommunityRuleVersionSchema,
  type ChatAttachment,
  type CommunityAttachment,
  type CommunityAttachmentDownload,
  type CommunityChannelMessagePage,
  type CommunityDiscoveryPage,
  type CommunityEventPage,
  type CommunityJoinResult,
  type CommunityMemberSearchResult,
  type CommunityMembership,
  type CommunityMessage,
  type CommunityNotificationMode,
  type CommunityPreview,
  type CommunityRealtimeSession,
  type CommunityRuleVersion,
} from "@openpond/contracts";
import type { RuntimeAccountContext } from "@openpond/runtime";
import { z } from "zod";
import { hostedApiAuthHeaders, resolveHostedApiAccess } from "./hosted-api-access.js";

export type CommunityClientDependencies = {
  fetchImpl?: typeof fetch;
  loadAccountContext?: () => Promise<RuntimeAccountContext>;
};

export type CommunityRequestAction =
  | { type: "discover"; cursor?: string | null }
  | { type: "preview"; slug: string }
  | { type: "rules"; communityId: string }
  | { type: "join"; communityId: string; acceptedRulesVersionId: string }
  | { type: "accept_rules"; communityId: string; acceptedRulesVersionId: string }
  | { type: "leave"; communityId: string }
  | { type: "channels"; communityId: string }
  | {
      type: "messages";
      communityId: string;
      channelId: string;
      beforeSequence?: number;
      limit?: number;
    }
  | {
      type: "message_send";
      communityId: string;
      channelId: string;
      body: string;
      clientRequestId: string;
      mentionUserIds?: string[];
      attachmentIds?: string[];
      replyToMessageId?: string | null;
    }
  | {
      type: "message_edit";
      communityId: string;
      channelId: string;
      messageId: string;
      body: string;
    }
  | {
      type: "message_delete";
      communityId: string;
      channelId: string;
      messageId: string;
    }
  | { type: "read"; communityId: string; channelId: string; sequence: number }
  | { type: "mute"; communityId: string; channelId: string; muted: boolean }
  | { type: "members"; communityId: string; query?: string; cursor?: string | null; limit?: number }
  | { type: "notifications"; communityId: string; mode: CommunityNotificationMode }
  | { type: "events"; communityId: string; after?: number; limit?: number }
  | { type: "realtime_session"; communityId: string }
  | { type: "attachment_upload"; communityId: string; channelId: string; attachment: ChatAttachment }
  | { type: "attachment_download"; communityId: string; channelId: string; attachmentId: string };

export type CommunityRequestResult =
  | CommunityDiscoveryPage
  | CommunityPreview
  | CommunityRuleVersion
  | CommunityJoinResult
  | CommunityMembership
  | CommunityChannelMessagePage
  | CommunityMessage
  | CommunityMemberSearchResult
  | CommunityEventPage
  | CommunityRealtimeSession
  | CommunityAttachment
  | CommunityAttachmentDownload
  | { channels: CommunityJoinResult["channels"] }
  | { accepted: true }
  | { sequence: number }
  | { channelId: string; mutedAt: string | null };

export class CommunityApiError extends Error {
  constructor(
    readonly code: string,
    readonly status: number,
    readonly details: Record<string, unknown> | null = null,
  ) {
    super(code);
    this.name = "CommunityApiError";
  }
}

const AcceptedSchema = z.object({ accepted: z.literal(true) });
const ReadSchema = z.object({ sequence: z.number().int().nonnegative() });
const MuteSchema = z.object({ channelId: z.string(), mutedAt: z.string().nullable() });

export async function communityRequestPayload(
  action: CommunityRequestAction,
  dependencies: CommunityClientDependencies = {},
): Promise<CommunityRequestResult> {
  if (action.type === "attachment_upload") return uploadCommunityAttachment(action, dependencies);
  const request = requestForAction(action);
  const payload = await requestCommunityApi(request.path, request.init, dependencies);
  return schemaForAction(action).parse(payload) as CommunityRequestResult;
}

async function requestCommunityApi(
  path: string,
  init: RequestInit = {},
  dependencies: CommunityClientDependencies = {},
): Promise<unknown> {
  const access = await resolveHostedApiAccess(dependencies);
  const headers = hostedApiAuthHeaders(access.token);
  headers.set("Content-Type", "application/json");
  const response = await (dependencies.fetchImpl ?? fetch)(`${access.apiBaseUrl}${path}`, {
    ...init,
    headers,
  });
  const payload = (await response.json().catch(() => ({}))) as {
    error?: unknown;
    message?: unknown;
    details?: unknown;
  };
  if (!response.ok) {
    const code =
      typeof payload.error === "string"
        ? payload.error
        : typeof payload.message === "string"
          ? payload.message
          : `community_http_${response.status}`;
    throw new CommunityApiError(
      code,
      response.status,
      payload.details && typeof payload.details === "object"
        ? (payload.details as Record<string, unknown>)
        : null,
    );
  }
  return payload;
}

function requestForAction(action: Exclude<CommunityRequestAction, { type: "attachment_upload" }>): {
  path: string;
  init?: RequestInit;
} {
  const community = "communityId" in action ? encodeURIComponent(action.communityId) : "";
  const channel = "channelId" in action ? encodeURIComponent(action.channelId) : "";
  switch (action.type) {
    case "discover": {
      const query = new URLSearchParams();
      if (action.cursor) query.set("cursor", action.cursor);
      return { path: `/v1/communities${query.size ? `?${query}` : ""}` };
    }
    case "preview":
      return { path: `/v1/communities/${encodeURIComponent(action.slug)}/preview` };
    case "rules":
      return { path: `/v1/communities/${community}/rules/current` };
    case "join":
      return post(`/v1/communities/${community}/join`, {
        acceptedRulesVersionId: action.acceptedRulesVersionId,
        accepted: true,
      });
    case "accept_rules":
      return post(`/v1/communities/${community}/rules/accept`, {
        acceptedRulesVersionId: action.acceptedRulesVersionId,
        accepted: true,
      });
    case "leave":
      return post(`/v1/communities/${community}/leave`, {});
    case "channels":
      return { path: `/v1/communities/${community}/channels` };
    case "messages": {
      const query = new URLSearchParams();
      if (action.beforeSequence != null) query.set("beforeSequence", String(action.beforeSequence));
      if (action.limit != null) query.set("limit", String(action.limit));
      return { path: `/v1/communities/${community}/channels/${channel}/messages${query.size ? `?${query}` : ""}` };
    }
    case "message_send":
      return post(`/v1/communities/${community}/channels/${channel}/messages`, {
        body: action.body,
        clientRequestId: action.clientRequestId,
        mentionUserIds: action.mentionUserIds ?? [],
        attachmentIds: action.attachmentIds ?? [],
        replyToMessageId: action.replyToMessageId ?? null,
      });
    case "message_edit":
      return jsonRequest(
        `/v1/communities/${community}/channels/${channel}/messages/${encodeURIComponent(action.messageId)}`,
        "PATCH",
        { body: action.body },
      );
    case "message_delete":
      return jsonRequest(
        `/v1/communities/${community}/channels/${channel}/messages/${encodeURIComponent(action.messageId)}`,
        "DELETE",
        {},
      );
    case "read":
      return post(`/v1/communities/${community}/channels/${channel}/read`, { sequence: action.sequence });
    case "mute":
      return post(`/v1/communities/${community}/channels/${channel}/mute`, { muted: action.muted });
    case "members": {
      const query = new URLSearchParams();
      if (action.query) query.set("query", action.query);
      if (action.cursor) query.set("cursor", action.cursor);
      if (action.limit != null) query.set("limit", String(action.limit));
      return { path: `/v1/communities/${community}/members/search${query.size ? `?${query}` : ""}` };
    }
    case "notifications":
      return post(`/v1/communities/${community}/notifications`, { mode: action.mode });
    case "events": {
      const query = new URLSearchParams();
      if (action.after != null) query.set("after", String(action.after));
      if (action.limit != null) query.set("limit", String(action.limit));
      return { path: `/v1/communities/${community}/events${query.size ? `?${query}` : ""}` };
    }
    case "realtime_session":
      return { path: `/v1/communities/${community}/realtime-session` };
    case "attachment_download":
      return { path: `/v1/communities/${community}/channels/${channel}/attachments/${encodeURIComponent(action.attachmentId)}/download` };
  }
}

function schemaForAction(action: CommunityRequestAction): z.ZodType {
  switch (action.type) {
    case "discover": return CommunityDiscoveryPageSchema;
    case "preview": return CommunityPreviewSchema;
    case "rules": return CommunityRuleVersionSchema;
    case "join": return CommunityJoinResultSchema;
    case "accept_rules": return AcceptedSchema;
    case "leave":
    case "notifications": return CommunityMembershipSchema;
    case "channels": return CommunityChannelsResultSchema;
    case "messages": return CommunityChannelMessagePageSchema;
    case "message_send":
    case "message_edit":
    case "message_delete": return CommunityMessageSchema;
    case "read": return ReadSchema;
    case "mute": return MuteSchema;
    case "members": return CommunityMemberSearchResultSchema;
    case "events": return CommunityEventPageSchema;
    case "realtime_session": return CommunityRealtimeSessionSchema;
    case "attachment_download": return CommunityAttachmentDownloadSchema;
    case "attachment_upload": return CommunityAttachmentSchema;
  }
}

async function uploadCommunityAttachment(
  action: Extract<CommunityRequestAction, { type: "attachment_upload" }>,
  dependencies: CommunityClientDependencies,
): Promise<CommunityAttachment> {
  const attachment = ChatAttachmentSchema.parse(action.attachment);
  if (attachment.kind !== "image" || !attachment.contentsBase64) {
    throw new CommunityApiError("community_attachment_invalid", 400);
  }
  const bytes = Buffer.from(attachment.contentsBase64, "base64");
  if (bytes.byteLength !== attachment.sizeBytes) {
    throw new CommunityApiError("community_attachment_size_mismatch", 400);
  }
  const base = `/v1/communities/${encodeURIComponent(action.communityId)}/channels/${encodeURIComponent(action.channelId)}/attachments`;
  const intent = CommunityAttachmentUploadSchema.parse(
    await requestCommunityApi(base, {
      method: "POST",
      body: JSON.stringify({
        clientAttachmentId: attachment.id,
        name: attachment.name,
        mediaType: attachment.mediaType,
        sizeBytes: attachment.sizeBytes,
      }),
    }, dependencies),
  );
  if (intent.attachment.status === "ready") return intent.attachment;
  if (!intent.uploadUrl) throw new CommunityApiError("community_attachment_upload_grant_missing", 502);
  const upload = await (dependencies.fetchImpl ?? fetch)(intent.uploadUrl, {
    method: "PUT",
    headers: intent.uploadHeaders,
    body: bytes,
  });
  if (!upload.ok) throw new CommunityApiError("community_attachment_upload_failed", upload.status);
  return CommunityAttachmentSchema.parse(
    await requestCommunityApi(
      `${base}/${encodeURIComponent(intent.attachment.id)}/finalize`,
      { method: "POST", body: "{}" },
      dependencies,
    ),
  );
}

function post(path: string, body: unknown) {
  return jsonRequest(path, "POST", body);
}

function jsonRequest(path: string, method: string, body: unknown) {
  return { path, init: { method, body: JSON.stringify(body) } };
}

export function parseCommunityNotificationMode(value: unknown): CommunityNotificationMode {
  return CommunityNotificationModeSchema.parse(value);
}
