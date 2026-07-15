import { ChatAttachmentSchema, CommunityNotificationModeSchema } from "@openpond/contracts";
import { z } from "zod";
import { CommunityApiError } from "../../openpond/community-client.js";
import { readJson, sendJson } from "../http.js";
import type { HttpRouteContext } from "../http-route-types.js";

const PREVIEW = /^\/v1\/communities\/([^/]+)\/preview$/;
const RULES = /^\/v1\/communities\/([^/]+)\/rules\/current$/;
const ACCEPT_RULES = /^\/v1\/communities\/([^/]+)\/rules\/accept$/;
const JOIN = /^\/v1\/communities\/([^/]+)\/join$/;
const LEAVE = /^\/v1\/communities\/([^/]+)\/leave$/;
const CHANNELS = /^\/v1\/communities\/([^/]+)\/channels$/;
const MESSAGES = /^\/v1\/communities\/([^/]+)\/channels\/([^/]+)\/messages$/;
const MESSAGE = /^\/v1\/communities\/([^/]+)\/channels\/([^/]+)\/messages\/([^/]+)$/;
const READ = /^\/v1\/communities\/([^/]+)\/channels\/([^/]+)\/read$/;
const MUTE = /^\/v1\/communities\/([^/]+)\/channels\/([^/]+)\/mute$/;
const ATTACHMENT_UPLOAD = /^\/v1\/communities\/([^/]+)\/channels\/([^/]+)\/attachments\/upload$/;
const ATTACHMENT_DOWNLOAD = /^\/v1\/communities\/([^/]+)\/channels\/([^/]+)\/attachments\/([^/]+)\/download$/;
const MEMBERS = /^\/v1\/communities\/([^/]+)\/members\/search$/;
const NOTIFICATIONS = /^\/v1\/communities\/([^/]+)\/notifications$/;
const EVENTS = /^\/v1\/communities\/([^/]+)\/events$/;
const REALTIME = /^\/v1\/communities\/([^/]+)\/realtime-session$/;

export async function handleCommunityRoutes({
  deps,
  request,
  requestUrl,
  response,
}: HttpRouteContext): Promise<boolean> {
  if (!requestUrl.pathname.startsWith("/v1/communities")) return false;
  try {
    return await handleCommunityRoute({ deps, request, requestUrl, response });
  } catch (error) {
    if (error instanceof CommunityApiError) {
      sendJson(response, error.status, { error: error.code, details: error.details });
      return true;
    }
    if (error instanceof z.ZodError) {
      sendJson(response, 400, { error: "community_invalid_request" });
      return true;
    }
    throw error;
  }
}

async function handleCommunityRoute({
  deps,
  request,
  requestUrl,
  response,
}: HttpRouteContext): Promise<boolean> {
  if (request.method === "GET" && requestUrl.pathname === "/v1/communities") {
    sendJson(response, 200, await deps.communityPayload({
      type: "discover",
      cursor: requestUrl.searchParams.get("cursor"),
    }));
    return true;
  }

  const preview = PREVIEW.exec(requestUrl.pathname);
  if (request.method === "GET" && preview) {
    sendJson(response, 200, await deps.communityPayload({ type: "preview", slug: decode(preview[1]) }));
    return true;
  }
  const rules = RULES.exec(requestUrl.pathname);
  if (request.method === "GET" && rules) {
    sendJson(response, 200, await deps.communityPayload({ type: "rules", communityId: decode(rules[1]) }));
    return true;
  }
  const join = JOIN.exec(requestUrl.pathname);
  if (request.method === "POST" && join) {
    const body = record(await readJson(request));
    sendJson(response, 201, await deps.communityPayload({
      type: "join",
      communityId: decode(join[1]),
      acceptedRulesVersionId: requiredString(body.acceptedRulesVersionId),
    }));
    return true;
  }
  const accept = ACCEPT_RULES.exec(requestUrl.pathname);
  if (request.method === "POST" && accept) {
    const body = record(await readJson(request));
    sendJson(response, 200, await deps.communityPayload({
      type: "accept_rules",
      communityId: decode(accept[1]),
      acceptedRulesVersionId: requiredString(body.acceptedRulesVersionId),
    }));
    return true;
  }
  const leave = LEAVE.exec(requestUrl.pathname);
  if (request.method === "POST" && leave) {
    sendJson(response, 200, await deps.communityPayload({ type: "leave", communityId: decode(leave[1]) }));
    return true;
  }
  const channels = CHANNELS.exec(requestUrl.pathname);
  if (request.method === "GET" && channels) {
    sendJson(response, 200, await deps.communityPayload({ type: "channels", communityId: decode(channels[1]) }));
    return true;
  }

  const attachmentUpload = ATTACHMENT_UPLOAD.exec(requestUrl.pathname);
  if (request.method === "POST" && attachmentUpload) {
    const body = record(await readJson(request));
    sendJson(response, 201, await deps.communityPayload({
      type: "attachment_upload",
      communityId: decode(attachmentUpload[1]),
      channelId: decode(attachmentUpload[2]),
      attachment: ChatAttachmentSchema.parse(body.attachment),
    }));
    return true;
  }
  const attachmentDownload = ATTACHMENT_DOWNLOAD.exec(requestUrl.pathname);
  if (request.method === "GET" && attachmentDownload) {
    sendJson(response, 200, await deps.communityPayload({
      type: "attachment_download",
      communityId: decode(attachmentDownload[1]),
      channelId: decode(attachmentDownload[2]),
      attachmentId: decode(attachmentDownload[3]),
    }));
    return true;
  }

  const messages = MESSAGES.exec(requestUrl.pathname);
  if (request.method === "GET" && messages) {
    sendJson(response, 200, await deps.communityPayload({
      type: "messages",
      communityId: decode(messages[1]),
      channelId: decode(messages[2]),
      beforeSequence: optionalInt(requestUrl.searchParams.get("beforeSequence")),
      limit: optionalInt(requestUrl.searchParams.get("limit")),
    }));
    return true;
  }
  if (request.method === "POST" && messages) {
    const body = record(await readJson(request));
    sendJson(response, 201, await deps.communityPayload({
      type: "message_send",
      communityId: decode(messages[1]),
      channelId: decode(messages[2]),
      body: rawString(body.body),
      clientRequestId: requiredString(body.clientRequestId),
      mentionUserIds: stringArray(body.mentionUserIds),
      attachmentIds: stringArray(body.attachmentIds),
      replyToMessageId: optionalString(body.replyToMessageId),
    }));
    return true;
  }
  const message = MESSAGE.exec(requestUrl.pathname);
  if ((request.method === "PATCH" || request.method === "DELETE") && message) {
    const body = record(await readJson(request));
    const common = {
      communityId: decode(message[1]),
      channelId: decode(message[2]),
      messageId: decode(message[3]),
    };
    sendJson(response, 200, await deps.communityPayload(
      request.method === "PATCH"
        ? { type: "message_edit", ...common, body: requiredString(body.body) }
        : { type: "message_delete", ...common },
    ));
    return true;
  }
  const read = READ.exec(requestUrl.pathname);
  if (request.method === "POST" && read) {
    const body = record(await readJson(request));
    sendJson(response, 200, await deps.communityPayload({
      type: "read",
      communityId: decode(read[1]),
      channelId: decode(read[2]),
      sequence: requiredInt(body.sequence),
    }));
    return true;
  }
  const mute = MUTE.exec(requestUrl.pathname);
  if (request.method === "POST" && mute) {
    const body = record(await readJson(request));
    sendJson(response, 200, await deps.communityPayload({
      type: "mute",
      communityId: decode(mute[1]),
      channelId: decode(mute[2]),
      muted: requiredBoolean(body.muted),
    }));
    return true;
  }
  const members = MEMBERS.exec(requestUrl.pathname);
  if (request.method === "GET" && members) {
    sendJson(response, 200, await deps.communityPayload({
      type: "members",
      communityId: decode(members[1]),
      query: requestUrl.searchParams.get("query") ?? "",
      cursor: requestUrl.searchParams.get("cursor"),
      limit: optionalInt(requestUrl.searchParams.get("limit")),
    }));
    return true;
  }
  const notifications = NOTIFICATIONS.exec(requestUrl.pathname);
  if (request.method === "POST" && notifications) {
    const body = record(await readJson(request));
    sendJson(response, 200, await deps.communityPayload({
      type: "notifications",
      communityId: decode(notifications[1]),
      mode: CommunityNotificationModeSchema.parse(body.mode),
    }));
    return true;
  }
  const events = EVENTS.exec(requestUrl.pathname);
  if (request.method === "GET" && events) {
    sendJson(response, 200, await deps.communityPayload({
      type: "events",
      communityId: decode(events[1]),
      after: optionalInt(requestUrl.searchParams.get("after")),
      limit: optionalInt(requestUrl.searchParams.get("limit")),
    }));
    return true;
  }
  const realtime = REALTIME.exec(requestUrl.pathname);
  if (request.method === "GET" && realtime) {
    sendJson(response, 200, await deps.communityPayload({
      type: "realtime_session",
      communityId: decode(realtime[1]),
    }));
    return true;
  }
  return false;
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function requiredString(value: unknown): string {
  const result = typeof value === "string" ? value.trim() : "";
  if (!result) invalidRequest();
  return result;
}

function rawString(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function optionalString(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string" && item.trim().length > 0)
    : [];
}

function requiredBoolean(value: unknown): boolean {
  if (typeof value !== "boolean") invalidRequest();
  return value;
}

function requiredInt(value: unknown): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0) {
    invalidRequest();
  }
  return value;
}

function invalidRequest(): never {
  throw new CommunityApiError("community_invalid_request", 400);
}

function optionalInt(value: string | null): number | undefined {
  if (!value) return undefined;
  const number = Number.parseInt(value, 10);
  return Number.isSafeInteger(number) && number >= 0 ? number : undefined;
}

function decode(value: string | undefined): string {
  if (!value) return "";
  try {
    return decodeURIComponent(value);
  } catch {
    invalidRequest();
  }
}
