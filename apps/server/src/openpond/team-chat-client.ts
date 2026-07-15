import {
  ChatAttachmentSchema,
  TeamChatAttachmentDownloadSchema,
  TeamChatAttachmentSchema,
  TeamChatAttachmentUploadSchema,
  TeamChatAiTurnSchema,
  TeamChatEventPageSchema,
  TeamChatHostedAiThreadSchema,
  TeamChatMemberSchema,
  TeamChatMessageSchema,
  TeamChatRealtimeSessionSchema,
  TeamChatThreadDetailSchema,
  TeamChatThreadMuteResultSchema,
  TeamChatThreadSchema,
  type TeamChatAiTurn,
  type TeamChatAgentCatalogEntry,
  type TeamChatAgentConversation,
  type TeamChatAgentRunResult,
  type ChatAttachment,
  type TeamChatAttachment,
  type TeamChatAttachmentDownload,
  type TeamChatEventPage,
  type TeamChatHostedAiThread,
  type TeamChatMember,
  type TeamChatMessage,
  type TeamChatRealtimeSession,
  type TeamChatThread,
  type TeamChatThreadDetail,
  type TeamChatThreadMuteResult,
} from "@openpond/contracts";
import { loadOpenPondAccountContext, type RuntimeAccountContext } from "@openpond/runtime";
import { z } from "zod";

const DEFAULT_OPENPOND_API_BASE_URL = "https://api.openpond.ai";

export type TeamChatClientDependencies = {
  fetchImpl?: typeof fetch;
  loadAccountContext?: () => Promise<RuntimeAccountContext>;
};

export type TeamChatRequestAction =
  | { type: "members"; teamId: string }
  | { type: "agents"; teamId: string }
  | { type: "threads"; teamId: string; includeArchived?: boolean }
  | { type: "events"; teamId: string; after?: number; limit?: number }
  | { type: "realtime_session"; teamId: string }
  | { type: "attachment_upload"; teamId: string; threadId: string; attachment: ChatAttachment }
  | { type: "attachment_download"; teamId: string; attachmentId: string }
  | { type: "general"; teamId: string }
  | { type: "dm"; teamId: string; otherUserId: string }
  | { type: "thread"; teamId: string; threadId: string; beforeSequence?: number; limit?: number }
  | {
      type: "message_send";
      teamId: string;
      threadId: string;
      body: string;
      clientRequestId: string;
      mentionUserIds?: string[];
      attachmentIds?: string[];
      replyToMessageId?: string | null;
    }
  | { type: "message_edit"; teamId: string; threadId: string; messageId: string; body: string }
  | { type: "message_delete"; teamId: string; threadId: string; messageId: string }
  | { type: "read"; teamId: string; threadId: string; sequence: number }
  | { type: "thread_mute"; teamId: string; threadId: string; muted: boolean }
  | {
      type: "agent_run_create";
      teamId: string;
      threadId: string;
      body: string;
      clientRequestId: string;
      selectedActionKey?: string | null;
      selectedAgentId?: string | null;
      conversationId?: string | null;
      targetProjectId?: string | null;
      approvalId?: string | null;
    }
  | { type: "agent_run"; teamId: string; agentRunId: string }
  | {
      type: "ai_thread_create";
      teamId: string;
      threadId: string;
      body: string;
      clientRequestId: string;
      providerId: string;
      modelId: string;
    }
  | { type: "ai_thread"; teamId: string; conversationId: string }
  | {
      type: "ai_turn_create";
      teamId: string;
      conversationId: string;
      body: string;
      clientRequestId: string;
      providerId: string;
      modelId: string;
    }
  | { type: "ai_turn_claim"; teamId: string; turnId: string; leaseSeconds?: number }
  | { type: "ai_turn_partial"; teamId: string; turnId: string; body: string; leaseSeconds?: number }
  | { type: "ai_turn_complete"; teamId: string; turnId: string; body: string }
  | {
      type: "ai_turn_fail";
      teamId: string;
      turnId: string;
      errorCode: string;
      interrupted?: boolean;
    }
  | { type: "ai_turn_cancel"; teamId: string; turnId: string };

export type TeamChatRequestResult =
  | { members: TeamChatMember[] }
  | { agents: TeamChatAgentCatalogEntry[] }
  | { threads: TeamChatThread[] }
  | TeamChatThreadDetail
  | TeamChatThreadMuteResult
  | TeamChatMessage
  | TeamChatHostedAiThread
  | TeamChatAiTurn
  | TeamChatEventPage
  | TeamChatRealtimeSession
  | TeamChatAttachment
  | TeamChatAttachmentDownload
  | TeamChatAgentRunResult
  | TeamChatAgentConversation
  | { sequence: number };

const MembersResponseSchema = z.object({ members: z.array(TeamChatMemberSchema) });
const AgentsResponseSchema = z.object({
  agents: z.array(
    z.object({
      id: z.string(),
      name: z.string(),
      label: z.string(),
      description: z.string().nullable(),
      inputSchema: z.string().nullable(),
      setupRequirements: z.array(z.record(z.string(), z.unknown())),
      implementation: z.object({
        type: z.literal("openpond-agent"),
        agentId: z.string(),
        agentName: z.string(),
        actionId: z.string(),
        profileProjectId: z.string(),
        profileName: z.string(),
      }),
      invokesModel: z.boolean(),
      approvalPolicy: z.object({
        required: z.boolean(),
        risk: z.enum(["read", "write", "destructive"]),
      }),
    }),
  ),
});
const ThreadsResponseSchema = z.object({ threads: z.array(TeamChatThreadSchema) });
const ReadResponseSchema = z.object({ sequence: z.number().int().nonnegative() });
const AgentRunResponseSchema = z.object({
  message: TeamChatMessageSchema,
  conversationId: z.string(),
  idempotentReplay: z.boolean(),
  agent: z.object({ id: z.string(), name: z.string() }).passthrough(),
  run: z
    .object({
      id: z.string(),
      status: z.string(),
      metadata: z.record(z.string(), z.unknown()),
    })
    .passthrough(),
});
const AgentConversationResponseSchema = z.object({
  conversationId: z.string(),
  teamId: z.string(),
  title: z.string().nullable(),
  agent: z.object({ id: z.string(), name: z.string(), slug: z.string() }),
  run: AgentRunResponseSchema.shape.run,
  messages: z.array(
    z.object({
      id: z.string(),
      sequence: z.number().int(),
      role: z.enum(["user", "assistant", "system", "action"]),
      body: z.string(),
      createdByUserId: z.string().nullable(),
      createdAt: z.string(),
    }),
  ),
  pinnedRouting: z.record(z.string(), z.unknown()),
});

export async function teamChatRequestPayload(
  action: TeamChatRequestAction,
  dependencies: TeamChatClientDependencies = {},
): Promise<TeamChatRequestResult> {
  if (action.type === "attachment_upload") {
    return uploadTeamChatAttachment(action, dependencies);
  }
  const request = requestForAction(action);
  const payload = await requestTeamChatApi(request.path, request.init, dependencies);
  return schemaForAction(action).parse(payload) as TeamChatRequestResult;
}

async function requestTeamChatApi(
  path: string,
  init: RequestInit = {},
  dependencies: TeamChatClientDependencies = {},
): Promise<unknown> {
  const access = await resolveTeamChatApiAccess(dependencies);
  const headers = authHeaders(access.token);
  headers.set("Content-Type", "application/json");
  const response = await (dependencies.fetchImpl ?? fetch)(`${access.apiBaseUrl}${path}`, {
    ...init,
    headers,
  });
  const payload = (await response.json().catch(() => ({}))) as {
    error?: unknown;
    message?: unknown;
  };
  if (!response.ok) {
    const message =
      typeof payload.message === "string"
        ? payload.message
        : typeof payload.error === "string"
          ? payload.error
          : response.statusText;
    throw new Error(message);
  }
  return payload;
}

function requestForAction(action: TeamChatRequestAction): {
  path: string;
  init?: RequestInit;
} {
  const teamQuery = `teamId=${encodeURIComponent(action.teamId)}`;
  switch (action.type) {
    case "attachment_upload":
      throw new Error("attachment uploads must use the coordinated upload path");
    case "members":
      return { path: `/v1/team-chat/members?${teamQuery}` };
    case "agents":
      return { path: `/v1/team-chat/agents?${teamQuery}` };
    case "threads":
      return {
        path: `/v1/team-chat/threads?${teamQuery}${action.includeArchived ? "&includeArchived=true" : ""}`,
      };
    case "events": {
      const query = new URLSearchParams({ teamId: action.teamId });
      if (action.after != null) query.set("after", String(action.after));
      if (action.limit != null) query.set("limit", String(action.limit));
      return { path: `/v1/team-chat/events?${query.toString()}` };
    }
    case "realtime_session":
      return { path: `/v1/team-chat/realtime-session?${teamQuery}` };
    case "attachment_download":
      return {
        path: `/v1/team-chat/attachments/${encodeURIComponent(action.attachmentId)}/download?${teamQuery}`,
      };
    case "general":
      return post("/v1/team-chat/threads/general", { teamId: action.teamId });
    case "dm":
      return post("/v1/team-chat/threads/dm", {
        teamId: action.teamId,
        otherUserId: action.otherUserId,
      });
    case "thread": {
      const query = new URLSearchParams({ teamId: action.teamId });
      if (action.beforeSequence != null) query.set("beforeSequence", String(action.beforeSequence));
      if (action.limit != null) query.set("limit", String(action.limit));
      return {
        path: `/v1/team-chat/threads/${encodeURIComponent(action.threadId)}?${query.toString()}`,
      };
    }
    case "message_send":
      return post(`/v1/team-chat/threads/${encodeURIComponent(action.threadId)}/messages`, {
        teamId: action.teamId,
        body: action.body,
        clientRequestId: action.clientRequestId,
        mentionUserIds: action.mentionUserIds ?? [],
        attachmentIds: action.attachmentIds ?? [],
        replyToMessageId: action.replyToMessageId ?? null,
      });
    case "message_edit":
      return jsonRequest(
        `/v1/team-chat/threads/${encodeURIComponent(action.threadId)}/messages/${encodeURIComponent(action.messageId)}`,
        "PATCH",
        { teamId: action.teamId, body: action.body },
      );
    case "message_delete":
      return jsonRequest(
        `/v1/team-chat/threads/${encodeURIComponent(action.threadId)}/messages/${encodeURIComponent(action.messageId)}`,
        "DELETE",
        { teamId: action.teamId },
      );
    case "read":
      return post(`/v1/team-chat/threads/${encodeURIComponent(action.threadId)}/read`, {
        teamId: action.teamId,
        sequence: action.sequence,
      });
    case "thread_mute":
      return post(`/v1/team-chat/threads/${encodeURIComponent(action.threadId)}/mute`, {
        teamId: action.teamId,
        muted: action.muted,
      });
    case "agent_run_create":
      return post(`/v1/team-chat/threads/${encodeURIComponent(action.threadId)}/agent-runs`, {
        teamId: action.teamId,
        body: action.body,
        clientRequestId: action.clientRequestId,
        selectedActionKey: action.selectedActionKey ?? null,
        selectedAgentId: action.selectedAgentId ?? null,
        conversationId: action.conversationId ?? null,
        targetProjectId: action.targetProjectId ?? null,
        approvalId: action.approvalId ?? null,
      });
    case "agent_run":
      return {
        path: `/v1/team-chat/agent-runs/${encodeURIComponent(action.agentRunId)}?${teamQuery}`,
      };
    case "ai_thread_create":
      return post(`/v1/team-chat/threads/${encodeURIComponent(action.threadId)}/ai-threads`, {
        teamId: action.teamId,
        body: action.body,
        clientRequestId: action.clientRequestId,
        providerId: action.providerId,
        modelId: action.modelId,
      });
    case "ai_thread":
      return {
        path: `/v1/team-chat/ai-threads/${encodeURIComponent(action.conversationId)}?${teamQuery}`,
      };
    case "ai_turn_create":
      return post(`/v1/team-chat/ai-threads/${encodeURIComponent(action.conversationId)}/turns`, {
        teamId: action.teamId,
        body: action.body,
        clientRequestId: action.clientRequestId,
        providerId: action.providerId,
        modelId: action.modelId,
      });
    case "ai_turn_claim":
      return post(`/v1/team-chat/ai-turns/${encodeURIComponent(action.turnId)}/claim`, {
        teamId: action.teamId,
        leaseSeconds: action.leaseSeconds ?? 90,
      });
    case "ai_turn_partial":
      return post(`/v1/team-chat/ai-turns/${encodeURIComponent(action.turnId)}/partial`, {
        teamId: action.teamId,
        body: action.body,
        leaseSeconds: action.leaseSeconds ?? 90,
      });
    case "ai_turn_complete":
      return post(`/v1/team-chat/ai-turns/${encodeURIComponent(action.turnId)}/complete`, {
        teamId: action.teamId,
        body: action.body,
      });
    case "ai_turn_fail":
      return post(`/v1/team-chat/ai-turns/${encodeURIComponent(action.turnId)}/fail`, {
        teamId: action.teamId,
        errorCode: action.errorCode,
        interrupted: action.interrupted ?? false,
      });
    case "ai_turn_cancel":
      return post(`/v1/team-chat/ai-turns/${encodeURIComponent(action.turnId)}/cancel`, {
        teamId: action.teamId,
      });
  }
}

function schemaForAction(action: TeamChatRequestAction): z.ZodType {
  switch (action.type) {
    case "members":
      return MembersResponseSchema;
    case "agents":
      return AgentsResponseSchema;
    case "threads":
      return ThreadsResponseSchema;
    case "events":
      return TeamChatEventPageSchema;
    case "realtime_session":
      return TeamChatRealtimeSessionSchema;
    case "attachment_download":
      return TeamChatAttachmentDownloadSchema;
    case "general":
    case "dm":
    case "thread":
      return TeamChatThreadDetailSchema;
    case "message_send":
    case "message_edit":
    case "message_delete":
      return TeamChatMessageSchema;
    case "read":
      return ReadResponseSchema;
    case "thread_mute":
      return TeamChatThreadMuteResultSchema;
    case "agent_run_create":
      return AgentRunResponseSchema;
    case "agent_run":
      return AgentConversationResponseSchema;
    case "ai_thread_create":
    case "ai_thread":
    case "ai_turn_create":
    case "ai_turn_complete":
      return TeamChatHostedAiThreadSchema;
    case "ai_turn_claim":
    case "ai_turn_partial":
    case "ai_turn_fail":
    case "ai_turn_cancel":
      return TeamChatAiTurnSchema;
    case "attachment_upload":
      return TeamChatAttachmentSchema;
  }
}

async function uploadTeamChatAttachment(
  action: Extract<TeamChatRequestAction, { type: "attachment_upload" }>,
  dependencies: TeamChatClientDependencies,
): Promise<TeamChatAttachment> {
  const attachment = ChatAttachmentSchema.parse(action.attachment);
  if (attachment.kind !== "image" || !attachment.contentsBase64) {
    throw new Error("team_chat_attachment_invalid");
  }
  const bytes = Buffer.from(attachment.contentsBase64, "base64");
  if (bytes.byteLength !== attachment.sizeBytes) {
    throw new Error("team_chat_attachment_size_mismatch");
  }
  const intent = TeamChatAttachmentUploadSchema.parse(
    await requestTeamChatApi(
      `/v1/team-chat/threads/${encodeURIComponent(action.threadId)}/attachments`,
      {
        method: "POST",
        body: JSON.stringify({
          teamId: action.teamId,
          clientAttachmentId: attachment.id,
          name: attachment.name,
          mediaType: attachment.mediaType,
          sizeBytes: attachment.sizeBytes,
        }),
      },
      dependencies,
    ),
  );
  if (intent.attachment.status === "ready") return intent.attachment;
  if (!intent.uploadUrl) throw new Error("team_chat_attachment_upload_grant_missing");
  const uploadResponse = await (dependencies.fetchImpl ?? fetch)(intent.uploadUrl, {
    method: "PUT",
    headers: intent.uploadHeaders,
    body: bytes,
  });
  if (!uploadResponse.ok) {
    throw new Error(`team_chat_attachment_upload_failed:${uploadResponse.status}`);
  }
  return TeamChatAttachmentSchema.parse(
    await requestTeamChatApi(
      `/v1/team-chat/threads/${encodeURIComponent(action.threadId)}/attachments/${encodeURIComponent(intent.attachment.id)}/finalize`,
      { method: "POST", body: JSON.stringify({ teamId: action.teamId }) },
      dependencies,
    ),
  );
}

function post(path: string, body: unknown): { path: string; init: RequestInit } {
  return jsonRequest(path, "POST", body);
}

function jsonRequest(
  path: string,
  method: string,
  body: unknown,
): { path: string; init: RequestInit } {
  return { path, init: { method, body: JSON.stringify(body) } };
}

async function resolveTeamChatApiAccess(dependencies: TeamChatClientDependencies = {}): Promise<{
  apiBaseUrl: string;
  token: string;
}> {
  const context = await (dependencies.loadAccountContext ?? loadOpenPondAccountContext)();
  const token = process.env.OPENPOND_SANDBOX_API_KEY?.trim() || context.token?.trim();
  if (!token) {
    throw new Error("OpenPond account API key is required to use team chat.");
  }
  return { apiBaseUrl: resolveApiBaseUrl(context), token };
}

function authHeaders(token: string): Headers {
  const headers = new Headers();
  if (token.startsWith("opk_")) {
    headers.set("Authorization", `ApiKey ${token}`);
    headers.set("openpond-api-key", token);
  } else {
    headers.set("Authorization", `Bearer ${token}`);
  }
  return headers;
}

function resolveApiBaseUrl(context: RuntimeAccountContext): string {
  return (
    normalizeOptionalUrl(process.env.OPENPOND_API_URL) ??
    apiBaseUrlFromSandboxApiUrl(process.env.OPENPOND_SANDBOX_API_URL) ??
    normalizeOptionalUrl(context.apiBaseUrl) ??
    normalizeOptionalUrl(context.account?.apiBaseUrl) ??
    normalizeOptionalUrl(context.config.apiBaseUrl) ??
    normalizeOpenPondWebBaseAsApi(context.account?.baseUrl) ??
    normalizeOpenPondWebBaseAsApi(context.config.baseUrl) ??
    DEFAULT_OPENPOND_API_BASE_URL
  );
}

export function apiBaseUrlFromSandboxApiUrl(value?: string | null): string | null {
  const normalized = normalizeOptionalUrl(value);
  if (!normalized) return null;
  try {
    const url = new URL(normalized);
    url.pathname =
      url.pathname
        .replace(/\/(?:v1|api)\/sandboxes\/?$/i, "")
        .replace(/\/sandboxes\/?$/i, "")
        .replace(/\/v1\/?$/i, "") || "/";
    url.search = "";
    url.hash = "";
    return url.toString().replace(/\/$/, "");
  } catch {
    return normalized
      .replace(/\/(?:v1|api)\/sandboxes\/?$/i, "")
      .replace(/\/sandboxes\/?$/i, "")
      .replace(/\/v1\/?$/i, "")
      .replace(/\/+$/, "");
  }
}

function normalizeOpenPondWebBaseAsApi(value?: string | null): string | null {
  const normalized = normalizeOptionalUrl(value);
  if (!normalized) return null;
  try {
    const url = new URL(normalized);
    if (url.hostname === "openpond.ai") return "https://api.openpond.ai";
    if (!url.hostname.startsWith("api.") && url.hostname.endsWith(".openpond.ai")) {
      url.hostname = `api.${url.hostname}`;
      return url.origin;
    }
  } catch {
    return normalized;
  }
  return normalized;
}

function normalizeOptionalUrl(value?: string | null): string | null {
  const trimmed = value?.trim();
  return trimmed ? trimmed.replace(/\/$/, "") : null;
}
