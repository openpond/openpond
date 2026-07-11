import { readJson, sendJson } from "../http.js";
import type { HttpRouteContext } from "../http-route-types.js";
import { ChatAttachmentSchema } from "@openpond/contracts";

const THREAD_PATH = /^\/v1\/team-chat\/threads\/([^/]+)$/;
const MESSAGE_COLLECTION_PATH = /^\/v1\/team-chat\/threads\/([^/]+)\/messages$/;
const ATTACHMENT_UPLOAD_PATH = /^\/v1\/team-chat\/threads\/([^/]+)\/attachments\/upload$/;
const ATTACHMENT_DOWNLOAD_PATH = /^\/v1\/team-chat\/attachments\/([^/]+)\/download$/;
const MESSAGE_PATH = /^\/v1\/team-chat\/threads\/([^/]+)\/messages\/([^/]+)$/;
const READ_PATH = /^\/v1\/team-chat\/threads\/([^/]+)\/read$/;
const AI_THREAD_CREATE_PATH = /^\/v1\/team-chat\/threads\/([^/]+)\/ai-threads$/;
const AI_THREAD_PATH = /^\/v1\/team-chat\/ai-threads\/([^/]+)$/;
const AI_TURN_COLLECTION_PATH = /^\/v1\/team-chat\/ai-threads\/([^/]+)\/turns$/;
const AI_TURN_ACTION_PATH =
  /^\/v1\/team-chat\/ai-turns\/([^/]+)\/(claim|partial|complete|fail|cancel)$/;
const AI_TURN_EXECUTE_PATH = /^\/v1\/team-chat\/ai-turns\/([^/]+)\/execute$/;
const AI_TURN_EXECUTION_CANCEL_PATH = /^\/v1\/team-chat\/ai-turns\/([^/]+)\/execute\/cancel$/;

export async function handleTeamChatRoutes({
  deps,
  request,
  requestUrl,
  response,
}: HttpRouteContext): Promise<boolean> {
  if (!requestUrl.pathname.startsWith("/v1/team-chat")) return false;

  if (request.method === "GET" && requestUrl.pathname === "/v1/team-chat/members") {
    sendJson(
      response,
      200,
      await deps.teamChatPayload({ type: "members", teamId: requiredTeamId(requestUrl) }),
    );
    return true;
  }
  if (request.method === "GET" && requestUrl.pathname === "/v1/team-chat/agents") {
    sendJson(
      response,
      200,
      await deps.teamChatPayload({ type: "agents", teamId: requiredTeamId(requestUrl) }),
    );
    return true;
  }
  if (request.method === "GET" && requestUrl.pathname === "/v1/team-chat/threads") {
    sendJson(
      response,
      200,
      await deps.teamChatPayload({
        type: "threads",
        teamId: requiredTeamId(requestUrl),
        includeArchived: requestUrl.searchParams.get("includeArchived") === "true",
      }),
    );
    return true;
  }
  if (
    request.method === "GET" &&
    requestUrl.pathname === "/v1/team-chat/realtime-session"
  ) {
    sendJson(
      response,
      200,
      await deps.teamChatPayload({
        type: "realtime_session",
        teamId: requiredTeamId(requestUrl),
      }),
    );
    return true;
  }
  if (request.method === "POST" && requestUrl.pathname === "/v1/team-chat/threads/general") {
    const body = asRecord(await readJson(request));
    sendJson(
      response,
      201,
      await deps.teamChatPayload({ type: "general", teamId: requiredString(body.teamId) }),
    );
    return true;
  }
  if (request.method === "POST" && requestUrl.pathname === "/v1/team-chat/threads/dm") {
    const body = asRecord(await readJson(request));
    sendJson(
      response,
      201,
      await deps.teamChatPayload({
        type: "dm",
        teamId: requiredString(body.teamId),
        otherUserId: requiredString(body.otherUserId),
      }),
    );
    return true;
  }
  if (request.method === "GET" && requestUrl.pathname === "/v1/team-chat/events") {
    sendJson(
      response,
      200,
      await deps.teamChatPayload({
        type: "events",
        teamId: requiredTeamId(requestUrl),
        after: optionalInt(requestUrl.searchParams.get("after")),
        limit: optionalInt(requestUrl.searchParams.get("limit")),
      }),
    );
    return true;
  }

  const attachmentDownloadMatch = ATTACHMENT_DOWNLOAD_PATH.exec(requestUrl.pathname);
  if (request.method === "GET" && attachmentDownloadMatch) {
    sendJson(
      response,
      200,
      await deps.teamChatPayload({
        type: "attachment_download",
        teamId: requiredTeamId(requestUrl),
        attachmentId: decode(attachmentDownloadMatch[1]),
      }),
    );
    return true;
  }

  const attachmentUploadMatch = ATTACHMENT_UPLOAD_PATH.exec(requestUrl.pathname);
  if (request.method === "POST" && attachmentUploadMatch) {
    const body = asRecord(await readJson(request));
    sendJson(
      response,
      201,
      await deps.teamChatPayload({
        type: "attachment_upload",
        teamId: requiredString(body.teamId),
        threadId: decode(attachmentUploadMatch[1]),
        attachment: ChatAttachmentSchema.parse(body.attachment),
      }),
    );
    return true;
  }

  const threadMatch = THREAD_PATH.exec(requestUrl.pathname);
  if (request.method === "GET" && threadMatch) {
    sendJson(
      response,
      200,
      await deps.teamChatPayload({
        type: "thread",
        teamId: requiredTeamId(requestUrl),
        threadId: decode(threadMatch[1]),
        beforeSequence: optionalInt(requestUrl.searchParams.get("beforeSequence")),
        limit: optionalInt(requestUrl.searchParams.get("limit")),
      }),
    );
    return true;
  }
  const messageCollectionMatch = MESSAGE_COLLECTION_PATH.exec(requestUrl.pathname);
  if (request.method === "POST" && messageCollectionMatch) {
    const body = asRecord(await readJson(request));
    sendJson(
      response,
      201,
      await deps.teamChatPayload({
        type: "message_send",
        teamId: requiredString(body.teamId),
        threadId: decode(messageCollectionMatch[1]),
        body: rawString(body.body),
        clientRequestId: requiredString(body.clientRequestId),
        mentionUserIds: stringArray(body.mentionUserIds),
        attachmentIds: stringArray(body.attachmentIds),
      }),
    );
    return true;
  }
  const messageMatch = MESSAGE_PATH.exec(requestUrl.pathname);
  if ((request.method === "PATCH" || request.method === "DELETE") && messageMatch) {
    const body = asRecord(await readJson(request));
    const common = {
      teamId: requiredString(body.teamId),
      threadId: decode(messageMatch[1]),
      messageId: decode(messageMatch[2]),
    };
    sendJson(
      response,
      200,
      await deps.teamChatPayload(
        request.method === "PATCH"
          ? { type: "message_edit", ...common, body: requiredString(body.body) }
          : { type: "message_delete", ...common },
      ),
    );
    return true;
  }
  const readMatch = READ_PATH.exec(requestUrl.pathname);
  if (request.method === "POST" && readMatch) {
    const body = asRecord(await readJson(request));
    sendJson(
      response,
      200,
      await deps.teamChatPayload({
        type: "read",
        teamId: requiredString(body.teamId),
        threadId: decode(readMatch[1]),
        sequence: requiredInt(body.sequence),
      }),
    );
    return true;
  }
  const aiThreadCreateMatch = AI_THREAD_CREATE_PATH.exec(requestUrl.pathname);
  if (request.method === "POST" && aiThreadCreateMatch) {
    const body = asRecord(await readJson(request));
    sendJson(
      response,
      201,
      await deps.teamChatPayload({
        type: "ai_thread_create",
        teamId: requiredString(body.teamId),
        threadId: decode(aiThreadCreateMatch[1]),
        body: requiredString(body.body),
        clientRequestId: requiredString(body.clientRequestId),
        providerId: requiredString(body.providerId),
        modelId: requiredString(body.modelId),
      }),
    );
    return true;
  }
  const aiThreadMatch = AI_THREAD_PATH.exec(requestUrl.pathname);
  if (request.method === "GET" && aiThreadMatch) {
    sendJson(
      response,
      200,
      await deps.teamChatPayload({
        type: "ai_thread",
        teamId: requiredTeamId(requestUrl),
        conversationId: decode(aiThreadMatch[1]),
      }),
    );
    return true;
  }
  const aiTurnCollectionMatch = AI_TURN_COLLECTION_PATH.exec(requestUrl.pathname);
  if (request.method === "POST" && aiTurnCollectionMatch) {
    const body = asRecord(await readJson(request));
    sendJson(
      response,
      201,
      await deps.teamChatPayload({
        type: "ai_turn_create",
        teamId: requiredString(body.teamId),
        conversationId: decode(aiTurnCollectionMatch[1]),
        body: requiredString(body.body),
        clientRequestId: requiredString(body.clientRequestId),
        providerId: requiredString(body.providerId),
        modelId: requiredString(body.modelId),
      }),
    );
    return true;
  }
  const executeCancelMatch = AI_TURN_EXECUTION_CANCEL_PATH.exec(requestUrl.pathname);
  if (request.method === "POST" && executeCancelMatch) {
    const body = asRecord(await readJson(request));
    sendJson(
      response,
      200,
      await deps.cancelTeamChatAiTurnExecution(
        decode(executeCancelMatch[1]),
        requiredString(body.teamId),
      ),
    );
    return true;
  }
  const executeMatch = AI_TURN_EXECUTE_PATH.exec(requestUrl.pathname);
  if (request.method === "POST" && executeMatch) {
    const body = asRecord(await readJson(request));
    sendJson(
      response,
      202,
      deps.executeTeamChatAiTurn(decode(executeMatch[1]), requiredString(body.teamId)),
    );
    return true;
  }
  const aiTurnActionMatch = AI_TURN_ACTION_PATH.exec(requestUrl.pathname);
  if (request.method === "POST" && aiTurnActionMatch) {
    const turnId = decode(aiTurnActionMatch[1]);
    const action = aiTurnActionMatch[2];
    const body = asRecord(await readJson(request));
    const teamId = requiredString(body.teamId);
    const payload =
      action === "claim"
        ? {
            type: "ai_turn_claim" as const,
            teamId,
            turnId,
            leaseSeconds: optionalNumber(body.leaseSeconds),
          }
        : action === "partial"
          ? {
              type: "ai_turn_partial" as const,
              teamId,
              turnId,
              body: rawString(body.body),
              leaseSeconds: optionalNumber(body.leaseSeconds),
            }
          : action === "complete"
            ? { type: "ai_turn_complete" as const, teamId, turnId, body: requiredString(body.body) }
            : action === "fail"
              ? {
                  type: "ai_turn_fail" as const,
                  teamId,
                  turnId,
                  errorCode: requiredString(body.errorCode),
                  interrupted: body.interrupted === true,
                }
              : { type: "ai_turn_cancel" as const, teamId, turnId };
    sendJson(response, 200, await deps.teamChatPayload(payload));
    return true;
  }
  return false;
}

function requiredTeamId(url: URL): string {
  return requiredString(url.searchParams.get("teamId"));
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function requiredString(value: unknown): string {
  const result = stringValue(value);
  if (!result) throw new Error("team_chat_invalid_request");
  return result;
}

function stringValue(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function rawString(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string" && item.trim().length > 0)
    : [];
}

function requiredInt(value: unknown): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0) {
    throw new Error("team_chat_invalid_request");
  }
  return value;
}

function optionalInt(value: string | null): number | undefined {
  if (!value) return undefined;
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : undefined;
}

function optionalNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function decode(value: string | undefined): string {
  return value ? decodeURIComponent(value) : "";
}
