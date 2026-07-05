import {
  BROWSER_HARNESS_KEYS,
  type BrowserHarnessClickInput,
  type BrowserHarnessInput,
  type BrowserHarnessKey,
  type BrowserHarnessKeyInput,
  type BrowserHarnessMoveCursorInput,
  type BrowserHarnessOpenInput,
  type BrowserHarnessOperation,
  type BrowserHarnessRequest,
  type BrowserHarnessScrollInput,
  type BrowserHarnessSnapshotInput,
  type BrowserHarnessTarget,
  type BrowserHarnessToolName,
  type BrowserHarnessTypeTextInput,
  type ParsedBrowserHarnessRequest,
} from "./desktop-browser-harness-types.js";

const MAX_ID_LENGTH = 256;
const MAX_URL_LENGTH = 4096;
const MAX_TEXT_LENGTH = 8000;
const MAX_WAIT_MS = 3000;
const MAX_SCROLL_DELTA = 4000;

export function parseBrowserHarnessRequest(input: unknown): ParsedBrowserHarnessRequest {
  const record = inputRecord(input, "Browser control request");
  const operation = parseOperation(record.operation);
  const toolName = parseToolName(record.toolName);
  assertOperationToolPair(operation, toolName);
  const request = {
    id: requiredString(record.id, "id", MAX_ID_LENGTH),
    operation,
    toolName,
    createdAt: requiredString(record.createdAt, "createdAt", MAX_ID_LENGTH),
    deadlineAt: requiredString(record.deadlineAt, "deadlineAt", MAX_ID_LENGTH),
    input: inputRecord(record.input, "Browser control input"),
  } satisfies BrowserHarnessRequest;
  return {
    ...request,
    input: parseBrowserHarnessInput(operation, request.input),
  } as ParsedBrowserHarnessRequest;
}

function parseBrowserHarnessInput(
  operation: BrowserHarnessOperation,
  input: Record<string, unknown>,
): BrowserHarnessInput {
  switch (operation) {
    case "open":
      return parseOpenInput(input);
    case "snapshot":
      return parseSnapshotInput(input);
    case "moveCursor":
      return parseMoveCursorInput(input);
    case "click":
      return parseClickInput(input);
    case "typeText":
      return parseTypeTextInput(input);
    case "pressKey":
      return parseKeyInput(input);
    case "scroll":
      return parseScrollInput(input);
  }
}

function parseOpenInput(input: Record<string, unknown>): BrowserHarnessOpenInput {
  return {
    ...baseInput(input),
    ...(optionalString(input.url, "url", MAX_URL_LENGTH) ? { url: optionalString(input.url, "url", MAX_URL_LENGTH)! } : {}),
  };
}

function parseSnapshotInput(input: Record<string, unknown>): BrowserHarnessSnapshotInput {
  return {
    ...baseInput(input),
    includeScreenshot: optionalBoolean(input.includeScreenshot, "includeScreenshot", false),
    maxTargets: optionalInteger(input.maxTargets, "maxTargets", 80, 1, 200),
  };
}

function parseMoveCursorInput(input: Record<string, unknown>): BrowserHarnessMoveCursorInput {
  return {
    ...baseInput(input),
    target: requiredTarget(input),
    waitAfterMoveMs: optionalInteger(input.waitAfterMoveMs, "waitAfterMoveMs", 0, 0, MAX_WAIT_MS),
  };
}

function parseClickInput(input: Record<string, unknown>): BrowserHarnessClickInput {
  const clickCount = optionalInteger(input.clickCount, "clickCount", 1, 1, 2);
  if (clickCount !== 1 && clickCount !== 2) throw new Error("clickCount must be 1 or 2.");
  return {
    ...baseInput(input),
    target: requiredTarget(input),
    button: optionalButton(input.button),
    clickCount,
  };
}

function parseTypeTextInput(input: Record<string, unknown>): BrowserHarnessTypeTextInput {
  const target = optionalRefTarget(input);
  return {
    ...baseInput(input),
    ...(target ? { target } : {}),
    text: requiredString(input.text, "text", MAX_TEXT_LENGTH),
  };
}

function parseKeyInput(input: Record<string, unknown>): BrowserHarnessKeyInput {
  if (!BROWSER_HARNESS_KEYS.includes(input.key as BrowserHarnessKey)) {
    throw new Error(`key must be one of: ${BROWSER_HARNESS_KEYS.join(", ")}.`);
  }
  return {
    ...baseInput(input),
    key: input.key as BrowserHarnessKey,
  };
}

function parseScrollInput(input: Record<string, unknown>): BrowserHarnessScrollInput {
  const deltaX = optionalNumber(input.deltaX, "deltaX", 0, -MAX_SCROLL_DELTA, MAX_SCROLL_DELTA);
  const deltaY = optionalNumber(input.deltaY, "deltaY", 0, -MAX_SCROLL_DELTA, MAX_SCROLL_DELTA);
  if (deltaX === 0 && deltaY === 0) throw new Error("deltaX or deltaY must be non-zero.");
  const target = optionalTarget(input);
  return {
    ...baseInput(input),
    ...(target ? { target } : {}),
    deltaX,
    deltaY,
  };
}

function baseInput(input: Record<string, unknown>) {
  const tabId = optionalString(input.tabId, "tabId", MAX_ID_LENGTH);
  return {
    sessionId: requiredString(input.sessionId, "sessionId", MAX_ID_LENGTH),
    turnId: requiredString(input.turnId, "turnId", MAX_ID_LENGTH),
    conversationId: requiredString(input.conversationId, "conversationId", MAX_ID_LENGTH),
    callId: requiredString(input.callId, "callId", MAX_ID_LENGTH),
    ...(tabId ? { tabId } : {}),
  };
}

function requiredTarget(input: Record<string, unknown>): BrowserHarnessTarget {
  const target = optionalTarget(input);
  if (!target) throw new Error("targetRef with snapshotId or x/y coordinates are required.");
  return target;
}

function optionalTarget(input: Record<string, unknown>): BrowserHarnessTarget | undefined {
  const refTarget = optionalRefTarget(input);
  const point = optionalPoint(input);
  if (refTarget && point) throw new Error("provide either targetRef/snapshotId or x/y, not both.");
  return refTarget ?? point;
}

function optionalRefTarget(
  input: Record<string, unknown>,
): Extract<BrowserHarnessTarget, { kind: "ref" }> | undefined {
  const targetRef = optionalString(input.targetRef, "targetRef", MAX_ID_LENGTH);
  const snapshotId = optionalString(input.snapshotId, "snapshotId", MAX_ID_LENGTH);
  if (!targetRef && !snapshotId) return undefined;
  if (!targetRef || !snapshotId) throw new Error("targetRef requires snapshotId.");
  return { kind: "ref", snapshotId, targetRef };
}

function optionalPoint(input: Record<string, unknown>): Extract<BrowserHarnessTarget, { kind: "point" }> | undefined {
  const hasX = input.x !== undefined && input.x !== null;
  const hasY = input.y !== undefined && input.y !== null;
  if (!hasX && !hasY) return undefined;
  if (!hasX || !hasY) throw new Error("x and y must be provided together.");
  return {
    kind: "point",
    point: {
      x: finiteNumber(input.x, "x"),
      y: finiteNumber(input.y, "y"),
    },
  };
}

function parseOperation(value: unknown): BrowserHarnessOperation {
  if (
    value === "open" ||
    value === "snapshot" ||
    value === "moveCursor" ||
    value === "click" ||
    value === "typeText" ||
    value === "pressKey" ||
    value === "scroll"
  ) {
    return value;
  }
  throw new Error("Unsupported browser control operation.");
}

function parseToolName(value: unknown): BrowserHarnessToolName {
  if (
    value === "openpond_browser_open" ||
    value === "openpond_browser_snapshot" ||
    value === "openpond_browser_move_cursor" ||
    value === "openpond_browser_click" ||
    value === "openpond_browser_type" ||
    value === "openpond_browser_key" ||
    value === "openpond_browser_scroll"
  ) {
    return value;
  }
  throw new Error("Unsupported browser control tool.");
}

function assertOperationToolPair(operation: BrowserHarnessOperation, toolName: BrowserHarnessToolName): void {
  const expected: Record<BrowserHarnessOperation, BrowserHarnessToolName> = {
    open: "openpond_browser_open",
    snapshot: "openpond_browser_snapshot",
    moveCursor: "openpond_browser_move_cursor",
    click: "openpond_browser_click",
    typeText: "openpond_browser_type",
    pressKey: "openpond_browser_key",
    scroll: "openpond_browser_scroll",
  };
  if (expected[operation] !== toolName) throw new Error("Browser operation and tool name do not match.");
}

function inputRecord(input: unknown, name: string): Record<string, unknown> {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw new Error(`${name} must be an object.`);
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

function optionalBoolean(value: unknown, name: string, fallback: boolean): boolean {
  if (value === undefined || value === null) return fallback;
  if (typeof value !== "boolean") throw new Error(`${name} must be a boolean.`);
  return value;
}

function optionalInteger(value: unknown, name: string, fallback: number, min: number, max: number): number {
  if (value === undefined || value === null) return fallback;
  if (typeof value !== "number" || !Number.isInteger(value)) throw new Error(`${name} must be an integer.`);
  if (value < min || value > max) throw new Error(`${name} must be between ${min} and ${max}.`);
  return value;
}

function optionalNumber(value: unknown, name: string, fallback: number, min: number, max: number): number {
  if (value === undefined || value === null) return fallback;
  if (typeof value !== "number" || !Number.isFinite(value)) throw new Error(`${name} must be a finite number.`);
  if (value < min || value > max) throw new Error(`${name} must be between ${min} and ${max}.`);
  return value;
}

function finiteNumber(value: unknown, name: string): number {
  if (typeof value !== "number" || !Number.isFinite(value)) throw new Error(`${name} must be a finite number.`);
  return value;
}

function optionalButton(value: unknown): "left" | "middle" | "right" {
  if (value === undefined || value === null) return "left";
  if (value === "left" || value === "middle" || value === "right") return value;
  throw new Error("button must be left, middle, or right.");
}
