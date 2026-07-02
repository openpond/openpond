import type {
  BrowserBounds,
  BrowserBoundsInput,
  BrowserConversationInput,
  BrowserNavigateInput,
  BrowserNewTabInput,
  BrowserTabInput,
  BrowserUrlInput,
} from "./desktop-browser-types.js";

const MAX_ID_LENGTH = 200;
const MAX_URL_LENGTH = 4096;

export function isTrustedBrowserIpcFrameUrl(frameUrl: string): boolean {
  try {
    const url = new URL(frameUrl);
    return url.protocol === "file:" || url.protocol === "app:" || isLoopbackDevUrl(url);
  } catch {
    return false;
  }
}

export function parseBrowserConversationInput(input: unknown): BrowserConversationInput {
  const record = inputRecord(input);
  return { conversationId: requiredString(record.conversationId, "conversationId", MAX_ID_LENGTH) };
}

export function parseBrowserTabInput(input: unknown): BrowserTabInput {
  const record = inputRecord(input);
  return {
    ...parseBrowserConversationInput(record),
    tabId: requiredString(record.tabId, "tabId", MAX_ID_LENGTH),
  };
}

export function parseBrowserUrlInput(input: unknown): BrowserUrlInput {
  const record = inputRecord(input);
  return {
    ...parseBrowserConversationInput(record),
    url: requiredString(record.url, "url", MAX_URL_LENGTH),
    ...(typeof record.explicitFile === "boolean" ? { explicitFile: record.explicitFile } : {}),
  };
}

export function parseBrowserNewTabInput(input: unknown): BrowserNewTabInput {
  const record = inputRecord(input);
  const url = optionalString(record.url, "url", MAX_URL_LENGTH);
  return {
    ...parseBrowserConversationInput(record),
    ...(url ? { url } : {}),
    ...(typeof record.explicitFile === "boolean" ? { explicitFile: record.explicitFile } : {}),
  };
}

export function parseBrowserNavigateInput(input: unknown): BrowserNavigateInput {
  return {
    ...parseBrowserTabInput(input),
    ...parseBrowserUrlInput(input),
  };
}

export function parseBrowserOpenExternalInput(input: unknown): BrowserTabInput | BrowserUrlInput {
  const record = inputRecord(input);
  if (typeof record.tabId === "string" && record.tabId.trim()) return parseBrowserTabInput(record);
  return parseBrowserUrlInput(record);
}

export function parseBrowserBoundsInput(input: unknown): BrowserBoundsInput {
  const record = inputRecord(input);
  return {
    ...parseBrowserConversationInput(record),
    bounds: record.bounds === null ? null : parseBounds(record.bounds),
  };
}

function parseBounds(input: unknown): BrowserBounds {
  const record = inputRecord(input);
  const bounds = {
    x: finiteNumber(record.x, "bounds.x"),
    y: finiteNumber(record.y, "bounds.y"),
    width: finiteNumber(record.width, "bounds.width"),
    height: finiteNumber(record.height, "bounds.height"),
  };
  if (bounds.width <= 0 || bounds.height <= 0) {
    throw new Error("bounds.width and bounds.height must be positive.");
  }
  return bounds;
}

function inputRecord(input: unknown): Record<string, unknown> {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw new Error("IPC payload must be an object.");
  }
  return input as Record<string, unknown>;
}

function requiredString(value: unknown, name: string, maxLength: number): string {
  const parsed = optionalString(value, name, maxLength);
  if (!parsed) throw new Error(`${name} is required.`);
  return parsed;
}

function optionalString(value: unknown, name: string, maxLength: number): string | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== "string") throw new Error(`${name} must be a string.`);
  const trimmed = value.trim();
  if (trimmed.length > maxLength) throw new Error(`${name} is too long.`);
  return trimmed || null;
}

function finiteNumber(value: unknown, name: string): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new Error(`${name} must be a finite number.`);
  }
  return value;
}

function isLoopbackDevUrl(url: URL): boolean {
  return (
    (url.protocol === "http:" || url.protocol === "https:") &&
    (url.hostname === "127.0.0.1" || url.hostname === "localhost" || url.hostname === "[::1]" || url.hostname === "::1")
  );
}
