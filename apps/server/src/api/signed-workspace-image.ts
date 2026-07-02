import { createHmac, timingSafeEqual } from "node:crypto";
import { Buffer } from "node:buffer";
import { normalizeWorkspaceFilePath, workspaceImageContentType } from "../workspace/workspace-common.js";

const SIGNED_WORKSPACE_IMAGE_TTL_MS = 5 * 60 * 1000;

type SignedWorkspaceImageClaims = {
  appId: string;
  path: string;
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

function signWorkspaceImageClaims(claims: SignedWorkspaceImageClaims, token: string): string {
  return createHmac("sha256", token)
    .update(`${claims.appId}
${claims.path}
${claims.expiresAt}`)
    .digest("base64url");
}

function safeSignatureEqual(actual: string, expected: string): boolean {
  const actualBytes = Buffer.from(actual);
  const expectedBytes = Buffer.from(expected);
  return actualBytes.byteLength === expectedBytes.byteLength && timingSafeEqual(actualBytes, expectedBytes);
}
