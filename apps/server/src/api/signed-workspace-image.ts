import { createHmac, timingSafeEqual } from "node:crypto";
import { Buffer } from "node:buffer";
import path from "node:path";
import { normalizeWorkspaceFilePath, workspaceImageContentType } from "../workspace/workspace-common.js";

const SIGNED_WORKSPACE_IMAGE_TTL_MS = 5 * 60 * 1000;
const CHAT_ATTACHMENT_IMAGE_CONTENT_TYPES = new Set(["image/gif", "image/jpeg", "image/png", "image/webp"]);

type SignedWorkspaceImageClaims = {
  appId: string;
  path: string;
  expiresAt: number;
};

type SignedLocalImageClaims = {
  path: string;
  expiresAt: number;
};

export type SignedChatAttachmentImageClaims = {
  sessionId: string;
  turnId: string;
  attachmentId: string;
  storageName: string;
  contentType: string;
  expiresAt: number;
};

export function signedWorkspaceImageUrlPayload(input: unknown, requestUrl: URL, token: string): {
  url: string;
  expiresAt: number;
} {
  const appId = requiredSignedAssetString(inputRecord(input).appId, "appId", 200);
  const rawPath = requiredSignedAssetString(inputRecord(input).path, "path", 4096);
  const imagePath = normalizeSignedWorkspaceImagePath(rawPath);
  if (!imagePath) throw new Error("Workspace image path is invalid.");
  const expiresAt = Date.now() + SIGNED_WORKSPACE_IMAGE_TTL_MS;
  const claims = { appId, path: imagePath, expiresAt };
  const url = new URL("/v1/assets/workspace-image", requestUrl.origin);
  url.searchParams.set("appId", claims.appId);
  url.searchParams.set("path", claims.path);
  url.searchParams.set("expiresAt", String(claims.expiresAt));
  url.searchParams.set("signature", signWorkspaceImageClaims(claims, token));
  return { url: url.toString(), expiresAt };
}

export function signedLocalImageUrlPayload(input: unknown, requestUrl: URL, token: string): {
  url: string;
  expiresAt: number;
} {
  const rawPath = requiredSignedAssetString(inputRecord(input).path, "path", 4096);
  const imagePath = normalizeSignedLocalImagePath(rawPath);
  if (!imagePath) throw new Error("Local image path is invalid.");
  const expiresAt = Date.now() + SIGNED_WORKSPACE_IMAGE_TTL_MS;
  const claims = { path: imagePath, expiresAt };
  const url = new URL("/v1/assets/local-image", requestUrl.origin);
  url.searchParams.set("path", claims.path);
  url.searchParams.set("expiresAt", String(claims.expiresAt));
  url.searchParams.set("signature", signLocalImageClaims(claims, token));
  return { url: url.toString(), expiresAt };
}

export function signedChatAttachmentImageUrlPayload(input: unknown, requestUrl: URL, token: string): {
  url: string;
  expiresAt: number;
} {
  const record = inputRecord(input);
  const sessionId = requiredSignedAssetString(record.sessionId, "sessionId", 200);
  const turnId = requiredSignedAssetString(record.turnId, "turnId", 200);
  const attachmentId = requiredSignedAssetString(record.attachmentId, "attachmentId", 200);
  const rawStorageName = requiredSignedAssetString(record.storageName, "storageName", 240);
  const rawContentType = requiredSignedAssetString(record.contentType, "contentType", 160);
  const storageName = normalizeSignedChatAttachmentStorageName(rawStorageName);
  const contentType = normalizeSignedChatAttachmentContentType(rawContentType);
  if (!storageName) throw new Error("Chat attachment image storage name is invalid.");
  if (!contentType) throw new Error("Chat attachment image content type is invalid.");
  const expiresAt = Date.now() + SIGNED_WORKSPACE_IMAGE_TTL_MS;
  const claims = { sessionId, turnId, attachmentId, storageName, contentType, expiresAt };
  const url = new URL("/v1/assets/chat-attachment-image", requestUrl.origin);
  url.searchParams.set("sessionId", claims.sessionId);
  url.searchParams.set("turnId", claims.turnId);
  url.searchParams.set("attachmentId", claims.attachmentId);
  url.searchParams.set("storageName", claims.storageName);
  url.searchParams.set("contentType", claims.contentType);
  url.searchParams.set("expiresAt", String(claims.expiresAt));
  url.searchParams.set("signature", signChatAttachmentImageClaims(claims, token));
  return { url: url.toString(), expiresAt };
}

export function verifySignedWorkspaceImageRequest(
  requestUrl: URL,
  token: string,
): { ok: true; claims: SignedWorkspaceImageClaims } | { ok: false; status: 401 | 404; error: string } {
  const appId = requiredSearchParam(requestUrl, "appId");
  const rawPath = requiredSearchParam(requestUrl, "path");
  const expiresRaw = requiredSearchParam(requestUrl, "expiresAt");
  const signature = requiredSearchParam(requestUrl, "signature");
  if (!appId || !rawPath || !expiresRaw || !signature) {
    return { ok: false, status: 401, error: "Signed asset URL is missing required claims." };
  }
  const path = normalizeSignedWorkspaceImagePath(rawPath);
  const expiresAt = Number(expiresRaw);
  if (!path || !Number.isInteger(expiresAt)) {
    return { ok: false, status: 401, error: "Signed asset URL is invalid." };
  }
  if (expiresAt < Date.now()) return { ok: false, status: 401, error: "Signed asset URL expired." };
  const claims = { appId: appId.trim(), path, expiresAt };
  if (!safeSignatureEqual(signature, signWorkspaceImageClaims(claims, token))) {
    return { ok: false, status: 401, error: "Signed asset URL signature is invalid." };
  }
  return { ok: true, claims };
}

export function verifySignedLocalImageRequest(
  requestUrl: URL,
  token: string,
): { ok: true; claims: SignedLocalImageClaims } | { ok: false; status: 401 | 404; error: string } {
  const rawPath = requiredSearchParam(requestUrl, "path");
  const expiresRaw = requiredSearchParam(requestUrl, "expiresAt");
  const signature = requiredSearchParam(requestUrl, "signature");
  if (!rawPath || !expiresRaw || !signature) {
    return { ok: false, status: 401, error: "Signed asset URL is missing required claims." };
  }
  const imagePath = normalizeSignedLocalImagePath(rawPath);
  const expiresAt = Number(expiresRaw);
  if (!imagePath || !Number.isInteger(expiresAt)) {
    return { ok: false, status: 401, error: "Signed asset URL is invalid." };
  }
  if (expiresAt < Date.now()) return { ok: false, status: 401, error: "Signed asset URL expired." };
  const claims = { path: imagePath, expiresAt };
  if (!safeSignatureEqual(signature, signLocalImageClaims(claims, token))) {
    return { ok: false, status: 401, error: "Signed asset URL signature is invalid." };
  }
  return { ok: true, claims };
}

export function verifySignedChatAttachmentImageRequest(
  requestUrl: URL,
  token: string,
): { ok: true; claims: SignedChatAttachmentImageClaims } | { ok: false; status: 401 | 404; error: string } {
  const sessionId = requiredSearchParam(requestUrl, "sessionId");
  const turnId = requiredSearchParam(requestUrl, "turnId");
  const attachmentId = requiredSearchParam(requestUrl, "attachmentId");
  const rawStorageName = requiredSearchParam(requestUrl, "storageName");
  const rawContentType = requiredSearchParam(requestUrl, "contentType");
  const expiresRaw = requiredSearchParam(requestUrl, "expiresAt");
  const signature = requiredSearchParam(requestUrl, "signature");
  if (!sessionId || !turnId || !attachmentId || !rawStorageName || !rawContentType || !expiresRaw || !signature) {
    return { ok: false, status: 401, error: "Signed asset URL is missing required claims." };
  }
  const storageName = normalizeSignedChatAttachmentStorageName(rawStorageName);
  const contentType = normalizeSignedChatAttachmentContentType(rawContentType);
  const expiresAt = Number(expiresRaw);
  if (!storageName || !contentType || !Number.isInteger(expiresAt)) {
    return { ok: false, status: 401, error: "Signed asset URL is invalid." };
  }
  if (expiresAt < Date.now()) return { ok: false, status: 401, error: "Signed asset URL expired." };
  const claims = {
    sessionId: sessionId.trim(),
    turnId: turnId.trim(),
    attachmentId: attachmentId.trim(),
    storageName,
    contentType,
    expiresAt,
  };
  if (!safeSignatureEqual(signature, signChatAttachmentImageClaims(claims, token))) {
    return { ok: false, status: 401, error: "Signed asset URL signature is invalid." };
  }
  return { ok: true, claims };
}

function inputRecord(input: unknown): Record<string, unknown> {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw new Error("Signed asset payload must be an object.");
  }
  return input as Record<string, unknown>;
}

function requiredSignedAssetString(value: unknown, name: string, maxLength: number): string {
  if (typeof value !== "string") throw new Error(`${name} must be a string.`);
  const trimmed = value.trim();
  if (!trimmed) throw new Error(`${name} is required.`);
  if (trimmed.length > maxLength) throw new Error(`${name} is too long.`);
  return trimmed;
}

function requiredSearchParam(requestUrl: URL, name: string): string | null {
  const value = requestUrl.searchParams.get(name);
  return value && value.trim() ? value : null;
}

function normalizeSignedWorkspaceImagePath(value: string): string | null {
  if (/^file:\/\//i.test(value) || /^\//.test(value) || /^[A-Za-z]:[\\/]/.test(value)) return null;
  const path = normalizeWorkspaceFilePath(value);
  if (!path || !workspaceImageContentType(path)) return null;
  return path;
}

function normalizeSignedLocalImagePath(value: string): string | null {
  let cleaned = value.trim().replace(/^['"`]+|['"`]+$/g, "");
  if (!cleaned) return null;
  if (cleaned.startsWith("file://")) {
    try {
      cleaned = decodeURIComponent(new URL(cleaned).pathname);
    } catch {
      cleaned = cleaned.replace(/^file:\/\//, "");
    }
  }
  if (!path.isAbsolute(cleaned)) return null;
  cleaned = path.resolve(cleaned);
  if (!workspaceImageContentType(cleaned)) return null;
  return cleaned;
}

function normalizeSignedChatAttachmentStorageName(value: string): string | null {
  const trimmed = value.trim();
  if (!trimmed || trimmed === "." || trimmed === ".." || trimmed.length > 240) return null;
  if (/[\\/]/.test(trimmed) || /^file:\/\//i.test(trimmed)) return null;
  return trimmed;
}

function normalizeSignedChatAttachmentContentType(value: string): string | null {
  const normalized = value.split(";")[0]?.trim().toLowerCase() ?? "";
  return CHAT_ATTACHMENT_IMAGE_CONTENT_TYPES.has(normalized) ? normalized : null;
}

function signWorkspaceImageClaims(claims: SignedWorkspaceImageClaims, token: string): string {
  return createHmac("sha256", token)
    .update(`${claims.appId}
${claims.path}
${claims.expiresAt}`)
    .digest("base64url");
}

function signLocalImageClaims(claims: SignedLocalImageClaims, token: string): string {
  return createHmac("sha256", token)
    .update(`${claims.path}
${claims.expiresAt}`)
    .digest("base64url");
}

function signChatAttachmentImageClaims(claims: SignedChatAttachmentImageClaims, token: string): string {
  return createHmac("sha256", token)
    .update(`${claims.sessionId}
${claims.turnId}
${claims.attachmentId}
${claims.storageName}
${claims.contentType}
${claims.expiresAt}`)
    .digest("base64url");
}

function safeSignatureEqual(actual: string, expected: string): boolean {
  const actualBytes = Buffer.from(actual);
  const expectedBytes = Buffer.from(expected);
  return actualBytes.byteLength === expectedBytes.byteLength && timingSafeEqual(actualBytes, expectedBytes);
}
