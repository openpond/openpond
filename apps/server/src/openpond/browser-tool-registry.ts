import type {
  ModelToolDefinition,
  ModelToolExecutionContext,
  ToolVisibilityContext,
} from "./model-tool-registry.js";
import type { NativeModelToolResult } from "./native-tool-calls.js";

export type BrowserHarnessToolName =
  | "openpond_browser_open"
  | "openpond_browser_snapshot"
  | "openpond_browser_move_cursor"
  | "openpond_browser_click"
  | "openpond_browser_type"
  | "openpond_browser_key"
  | "openpond_browser_scroll";

export type BrowserHarnessPoint = {
  x: number;
  y: number;
};

export type BrowserHarnessTarget =
  | {
      kind: "ref";
      snapshotId: string;
      targetRef: string;
    }
  | {
      kind: "point";
      point: BrowserHarnessPoint;
    };

export type BrowserHarnessBaseInput = {
  sessionId: string;
  turnId: string;
  conversationId: string;
  callId: string;
  tabId?: string;
  signal: AbortSignal;
};

export type BrowserHarnessOpenInput = BrowserHarnessBaseInput & {
  url?: string;
};

export type BrowserHarnessSnapshotInput = BrowserHarnessBaseInput & {
  includeScreenshot: boolean;
  maxTargets: number;
};

export type BrowserHarnessMoveCursorInput = BrowserHarnessBaseInput & {
  target: BrowserHarnessTarget;
  waitAfterMoveMs: number;
};

export type BrowserHarnessClickInput = BrowserHarnessBaseInput & {
  target: BrowserHarnessTarget;
  button: "left" | "middle" | "right";
  clickCount: 1 | 2;
};

export type BrowserHarnessTypeTextInput = BrowserHarnessBaseInput & {
  target?: Extract<BrowserHarnessTarget, { kind: "ref" }>;
  text: string;
};

export type BrowserHarnessKeyInput = BrowserHarnessBaseInput & {
  key: BrowserHarnessKey;
};

export type BrowserHarnessScrollInput = BrowserHarnessBaseInput & {
  target?: BrowserHarnessTarget;
  deltaX: number;
  deltaY: number;
};

export type BrowserHarnessScreenshotMetadata = {
  tabId: string;
  url: string;
};

export type BrowserHarnessResponseMetadata = {
  activeTabId?: string;
  title?: string;
  url?: string;
  openTabIds?: string[];
  cursor?: BrowserHarnessPoint;
  snapshotId?: string;
  screenshot?: BrowserHarnessScreenshotMetadata;
};

export type BrowserHarnessToolResult = {
  ok: boolean;
  action: BrowserHarnessToolName;
  output: string;
  data?: Record<string, unknown>;
  metadata?: BrowserHarnessResponseMetadata;
};

export type BrowserHarnessToolExecutor = {
  available(input: { sessionId: string; conversationId: string }): boolean;
  open(input: BrowserHarnessOpenInput): Promise<BrowserHarnessToolResult>;
  snapshot(input: BrowserHarnessSnapshotInput): Promise<BrowserHarnessToolResult>;
  moveCursor(input: BrowserHarnessMoveCursorInput): Promise<BrowserHarnessToolResult>;
  click(input: BrowserHarnessClickInput): Promise<BrowserHarnessToolResult>;
  typeText(input: BrowserHarnessTypeTextInput): Promise<BrowserHarnessToolResult>;
  pressKey(input: BrowserHarnessKeyInput): Promise<BrowserHarnessToolResult>;
  scroll(input: BrowserHarnessScrollInput): Promise<BrowserHarnessToolResult>;
};

const BROWSER_TEXT_MAX_LENGTH = 8000;
const BROWSER_URL_MAX_LENGTH = 4096;
const BROWSER_ID_MAX_LENGTH = 256;
const BROWSER_WAIT_MAX_MS = 3000;
const BROWSER_SCROLL_MAX_DELTA = 4000;

const BROWSER_KEYS = [
  "Enter",
  "Tab",
  "Escape",
  "Space",
  "Backspace",
  "Delete",
  "ArrowUp",
  "ArrowDown",
  "ArrowLeft",
  "ArrowRight",
  "Home",
  "End",
  "PageUp",
  "PageDown",
  "Ctrl+L",
  "Meta+L",
  "Ctrl+R",
  "Meta+R",
  "Ctrl+A",
  "Meta+A",
  "Ctrl+C",
  "Meta+C",
  "Ctrl+V",
  "Meta+V",
] as const;

export type BrowserHarnessKey = (typeof BROWSER_KEYS)[number];

export function createBrowserModelToolDefinitions(
  executor?: BrowserHarnessToolExecutor | null,
): ModelToolDefinition[] {
  if (!executor) return [];

  const enabled = (context: ToolVisibilityContext) =>
    executor.available({ sessionId: context.session.id, conversationId: context.session.id });

  return [
    {
      name: "openpond_browser_open",
      description:
        "Open or focus the in-app browser for the current chat. Use this before interacting with a page that is not already open.",
      parameters: {
        type: "object",
        additionalProperties: false,
        properties: {
          url: {
            type: "string",
            minLength: 1,
            maxLength: BROWSER_URL_MAX_LENGTH,
            description: "Optional URL to open or focus in the current chat's browser context.",
          },
          tabId: browserTabIdSchema(),
        },
      },
      enabled,
      execute: async (context) =>
        browserToolModelResult(
          context.callId,
          "openpond_browser_open",
          await executor.open(openInput(context)),
        ),
    },
    {
      name: "openpond_browser_snapshot",
      description:
        "Capture a bounded snapshot of the active in-app browser tab, including stable target refs for follow-up browser actions.",
      parameters: {
        type: "object",
        additionalProperties: false,
        properties: {
          tabId: browserTabIdSchema(),
          includeScreenshot: {
            type: "boolean",
            description: "Whether to include screenshot proof metadata when available. Default false.",
          },
          maxTargets: {
            type: "integer",
            minimum: 1,
            maximum: 200,
            description: "Maximum number of interactable snapshot targets to return.",
          },
        },
      },
      enabled,
      execute: async (context) =>
        browserToolModelResult(
          context.callId,
          "openpond_browser_snapshot",
          await executor.snapshot(snapshotInput(context)),
        ),
    },
    {
      name: "openpond_browser_move_cursor",
      description:
        "Move the visible browser cursor to a snapshot target ref or fallback viewport point. Use for hover/flyout behavior or user-visible proof before an action.",
      parameters: targetParameters({
        extra: {
          tabId: browserTabIdSchema(),
          waitAfterMoveMs: {
            type: "integer",
            minimum: 0,
            maximum: BROWSER_WAIT_MAX_MS,
            description: "Optional short wait after moving the cursor, useful for hover UI.",
          },
        },
      }),
      enabled,
      execute: async (context) =>
        browserToolModelResult(
          context.callId,
          "openpond_browser_move_cursor",
          await executor.moveCursor(moveCursorInput(context)),
        ),
    },
    {
      name: "openpond_browser_click",
      description:
        "Click a snapshot target ref in the active browser tab. Viewport coordinates are allowed only as a fallback for visual-only surfaces.",
      parameters: targetParameters({
        extra: {
          tabId: browserTabIdSchema(),
          button: {
            type: "string",
            enum: ["left", "middle", "right"],
            description: "Mouse button. Default left.",
          },
          clickCount: {
            type: "integer",
            enum: [1, 2],
            description: "Click count. Use 2 only for deliberate double-clicks.",
          },
        },
      }),
      enabled,
      execute: async (context) =>
        browserToolModelResult(
          context.callId,
          "openpond_browser_click",
          await executor.click(clickInput(context)),
        ),
    },
    {
      name: "openpond_browser_type",
      description:
        "Type bounded text into a snapshot target ref or the currently focused browser element. Typed text is redacted from diagnostics.",
      parameters: {
        type: "object",
        additionalProperties: false,
        properties: {
          tabId: browserTabIdSchema(),
          snapshotId: browserSnapshotIdSchema(),
          targetRef: browserTargetRefSchema(),
          text: {
            type: "string",
            minLength: 1,
            maxLength: BROWSER_TEXT_MAX_LENGTH,
            description: "Text to type or fill. This value is not echoed in diagnostics.",
          },
        },
        required: ["text"],
      },
      enabled,
      execute: async (context) =>
        browserToolModelResult(
          context.callId,
          "openpond_browser_type",
          await executor.typeText(typeTextInput(context)),
        ),
    },
    {
      name: "openpond_browser_key",
      description:
        "Press a constrained browser key or key chord in the focused active tab, such as Enter, Tab, Escape, arrows, Ctrl+L, or Meta+R.",
      parameters: {
        type: "object",
        additionalProperties: false,
        properties: {
          tabId: browserTabIdSchema(),
          key: {
            type: "string",
            enum: [...BROWSER_KEYS],
            description: "Constrained key or key chord to press.",
          },
        },
        required: ["key"],
      },
      enabled,
      execute: async (context) =>
        browserToolModelResult(
          context.callId,
          "openpond_browser_key",
          await executor.pressKey(keyInput(context)),
        ),
    },
    {
      name: "openpond_browser_scroll",
      description:
        "Scroll the browser page or a snapshot target ref by bounded deltas. Use refs over coordinates when available.",
      parameters: targetParameters({
        required: ["deltaY"],
        extra: {
          tabId: browserTabIdSchema(),
          deltaX: {
            type: "number",
            minimum: -BROWSER_SCROLL_MAX_DELTA,
            maximum: BROWSER_SCROLL_MAX_DELTA,
            description: "Horizontal scroll delta. Default 0.",
          },
          deltaY: {
            type: "number",
            minimum: -BROWSER_SCROLL_MAX_DELTA,
            maximum: BROWSER_SCROLL_MAX_DELTA,
            description: "Vertical scroll delta.",
          },
        },
      }),
      enabled,
      execute: async (context) =>
        browserToolModelResult(
          context.callId,
          "openpond_browser_scroll",
          await executor.scroll(scrollInput(context)),
        ),
    },
  ];
}

export function redactBrowserToolArguments(
  toolName: string,
  args: Record<string, unknown>,
): Record<string, unknown> {
  if (!isBrowserToolName(toolName)) return args;
  const redacted = { ...args };
  if (typeof redacted.url === "string") redacted.url = redactBrowserUrl(redacted.url);
  if (toolName === "openpond_browser_type") {
    const text = typeof args.text === "string" ? args.text : "";
    redacted.text = text ? `[redacted ${text.length} chars]` : "[redacted]";
  }
  return redacted;
}

export function isBrowserToolName(toolName: string): toolName is BrowserHarnessToolName {
  return (
    toolName === "openpond_browser_open" ||
    toolName === "openpond_browser_snapshot" ||
    toolName === "openpond_browser_move_cursor" ||
    toolName === "openpond_browser_click" ||
    toolName === "openpond_browser_type" ||
    toolName === "openpond_browser_key" ||
    toolName === "openpond_browser_scroll"
  );
}

function openInput(context: ModelToolExecutionContext): BrowserHarnessOpenInput {
  return {
    ...baseInput(context),
    ...(optionalTabId(context.args) ? { tabId: optionalTabId(context.args)! } : {}),
    ...(optionalString(context.args, "url", BROWSER_URL_MAX_LENGTH) ? { url: optionalString(context.args, "url", BROWSER_URL_MAX_LENGTH)! } : {}),
  };
}

function snapshotInput(context: ModelToolExecutionContext): BrowserHarnessSnapshotInput {
  return {
    ...baseInput(context),
    ...(optionalTabId(context.args) ? { tabId: optionalTabId(context.args)! } : {}),
    includeScreenshot: booleanArg(context.args, "includeScreenshot", false),
    maxTargets: integerArg(context.args, "maxTargets", 80, 1, 200),
  };
}

function moveCursorInput(context: ModelToolExecutionContext): BrowserHarnessMoveCursorInput {
  return {
    ...baseInput(context),
    ...(optionalTabId(context.args) ? { tabId: optionalTabId(context.args)! } : {}),
    target: requiredTarget(context.args),
    waitAfterMoveMs: integerArg(context.args, "waitAfterMoveMs", 0, 0, BROWSER_WAIT_MAX_MS),
  };
}

function clickInput(context: ModelToolExecutionContext): BrowserHarnessClickInput {
  const button = context.args.button ?? "left";
  if (button !== "left" && button !== "middle" && button !== "right") {
    throw new Error("button must be left, middle, or right");
  }
  const clickCount = integerArg(context.args, "clickCount", 1, 1, 2);
  if (clickCount !== 1 && clickCount !== 2) throw new Error("clickCount must be 1 or 2");
  return {
    ...baseInput(context),
    ...(optionalTabId(context.args) ? { tabId: optionalTabId(context.args)! } : {}),
    target: requiredTarget(context.args),
    button,
    clickCount,
  };
}

function typeTextInput(context: ModelToolExecutionContext): BrowserHarnessTypeTextInput {
  const target = optionalRefTarget(context.args);
  return {
    ...baseInput(context),
    ...(optionalTabId(context.args) ? { tabId: optionalTabId(context.args)! } : {}),
    ...(target ? { target } : {}),
    text: stringArg(context.args, "text", BROWSER_TEXT_MAX_LENGTH),
  };
}

function keyInput(context: ModelToolExecutionContext): BrowserHarnessKeyInput {
  const key = context.args.key;
  if (!BROWSER_KEYS.includes(key as BrowserHarnessKey)) {
    throw new Error(`key must be one of: ${BROWSER_KEYS.join(", ")}`);
  }
  return {
    ...baseInput(context),
    ...(optionalTabId(context.args) ? { tabId: optionalTabId(context.args)! } : {}),
    key: key as BrowserHarnessKey,
  };
}

function scrollInput(context: ModelToolExecutionContext): BrowserHarnessScrollInput {
  const deltaX = numberArg(context.args, "deltaX", 0, -BROWSER_SCROLL_MAX_DELTA, BROWSER_SCROLL_MAX_DELTA);
  const deltaY = numberArg(context.args, "deltaY", 0, -BROWSER_SCROLL_MAX_DELTA, BROWSER_SCROLL_MAX_DELTA);
  if (deltaX === 0 && deltaY === 0) throw new Error("deltaX or deltaY must be non-zero");
  const target = optionalTarget(context.args);
  return {
    ...baseInput(context),
    ...(optionalTabId(context.args) ? { tabId: optionalTabId(context.args)! } : {}),
    ...(target ? { target } : {}),
    deltaX,
    deltaY,
  };
}

function baseInput(context: ModelToolExecutionContext): BrowserHarnessBaseInput {
  return {
    sessionId: context.session.id,
    turnId: context.turnId,
    conversationId: context.session.id,
    callId: context.callId,
    signal: context.signal,
  };
}

function browserToolModelResult(
  callId: string,
  toolName: BrowserHarnessToolName,
  result: BrowserHarnessToolResult,
): NativeModelToolResult {
  const content = {
    ok: result.ok,
    action: result.action,
    output: result.output,
    ...(result.data ? { data: result.data } : {}),
    ...(result.metadata
      ? {
          browser: browserModelMetadata(result.metadata),
        }
      : {}),
  };
  return {
    toolCallId: callId,
    name: toolName,
    ok: result.ok,
    contentText: JSON.stringify(content, null, 2),
    data: {
      ...content,
      ...(result.metadata ? { metadata: result.metadata } : {}),
    },
  };
}

function browserModelMetadata(metadata: BrowserHarnessResponseMetadata): Record<string, unknown> {
  return {
    ...(metadata.activeTabId ? { activeTabId: metadata.activeTabId } : {}),
    ...(metadata.title ? { title: metadata.title } : {}),
    ...(metadata.url ? { url: redactBrowserUrl(metadata.url) } : {}),
    ...(metadata.openTabIds ? { openTabIds: metadata.openTabIds } : {}),
    ...(metadata.cursor ? { cursor: metadata.cursor } : {}),
    ...(metadata.snapshotId ? { snapshotId: metadata.snapshotId } : {}),
    ...(metadata.screenshot ? { screenshot: { tabId: metadata.screenshot.tabId, available: true } } : {}),
  };
}

function requiredTarget(args: Record<string, unknown>): BrowserHarnessTarget {
  const target = optionalTarget(args);
  if (!target) throw new Error("targetRef with snapshotId or x/y coordinates are required");
  return target;
}

function optionalTarget(args: Record<string, unknown>): BrowserHarnessTarget | undefined {
  const refTarget = optionalRefTarget(args);
  const point = optionalPoint(args);
  if (refTarget && point) throw new Error("provide either targetRef/snapshotId or x/y, not both");
  return refTarget ?? point;
}

function optionalRefTarget(args: Record<string, unknown>): Extract<BrowserHarnessTarget, { kind: "ref" }> | undefined {
  const targetRef = optionalString(args, "targetRef", BROWSER_ID_MAX_LENGTH);
  const snapshotId = optionalString(args, "snapshotId", BROWSER_ID_MAX_LENGTH);
  if (!targetRef && !snapshotId) return undefined;
  if (!targetRef || !snapshotId) throw new Error("targetRef requires snapshotId");
  return { kind: "ref", snapshotId, targetRef };
}

function optionalPoint(args: Record<string, unknown>): Extract<BrowserHarnessTarget, { kind: "point" }> | undefined {
  const hasX = args.x !== undefined && args.x !== null;
  const hasY = args.y !== undefined && args.y !== null;
  if (!hasX && !hasY) return undefined;
  if (!hasX || !hasY) throw new Error("x and y must be provided together");
  return {
    kind: "point",
    point: {
      x: finiteNumberArg(args, "x"),
      y: finiteNumberArg(args, "y"),
    },
  };
}

function browserTabIdSchema(): Record<string, unknown> {
  return {
    type: "string",
    minLength: 1,
    maxLength: BROWSER_ID_MAX_LENGTH,
    description: "Optional active browser tab id. Omit to use the active tab for the current chat.",
  };
}

function browserSnapshotIdSchema(): Record<string, unknown> {
  return {
    type: "string",
    minLength: 1,
    maxLength: BROWSER_ID_MAX_LENGTH,
    description: "Snapshot id returned by openpond_browser_snapshot.",
  };
}

function browserTargetRefSchema(): Record<string, unknown> {
  return {
    type: "string",
    minLength: 1,
    maxLength: BROWSER_ID_MAX_LENGTH,
    description: "Stable target ref returned by openpond_browser_snapshot.",
  };
}

function targetParameters(input: {
  extra?: Record<string, unknown>;
  required?: string[];
} = {}): Record<string, unknown> {
  return {
    type: "object",
    additionalProperties: false,
    properties: {
      snapshotId: browserSnapshotIdSchema(),
      targetRef: browserTargetRefSchema(),
      x: {
        type: "number",
        description: "Viewport-relative x coordinate fallback.",
      },
      y: {
        type: "number",
        description: "Viewport-relative y coordinate fallback.",
      },
      ...(input.extra ?? {}),
    },
    required: input.required ?? [],
  };
}

function optionalTabId(args: Record<string, unknown>): string | null {
  return optionalString(args, "tabId", BROWSER_ID_MAX_LENGTH);
}

function stringArg(args: Record<string, unknown>, key: string, maxLength: number): string {
  const value = args[key];
  if (typeof value !== "string" || !value.trim()) throw new Error(`${key} is required`);
  const trimmed = value.trim();
  if (trimmed.length > maxLength) throw new Error(`${key} is too long`);
  return trimmed;
}

function optionalString(args: Record<string, unknown>, key: string, maxLength: number): string | null {
  const value = args[key];
  if (value === undefined || value === null) return null;
  if (typeof value !== "string" || !value.trim()) throw new Error(`${key} must be a non-empty string`);
  const trimmed = value.trim();
  if (trimmed.length > maxLength) throw new Error(`${key} is too long`);
  return trimmed;
}

function booleanArg(args: Record<string, unknown>, key: string, fallback: boolean): boolean {
  const value = args[key];
  if (value === undefined || value === null) return fallback;
  if (typeof value !== "boolean") throw new Error(`${key} must be a boolean`);
  return value;
}

function integerArg(
  args: Record<string, unknown>,
  key: string,
  fallback: number,
  min: number,
  max: number,
): number {
  const value = args[key];
  if (value === undefined || value === null) return fallback;
  if (typeof value !== "number" || !Number.isInteger(value)) throw new Error(`${key} must be an integer`);
  if (value < min || value > max) throw new Error(`${key} must be between ${min} and ${max}`);
  return value;
}

function numberArg(
  args: Record<string, unknown>,
  key: string,
  fallback: number,
  min: number,
  max: number,
): number {
  const value = args[key];
  if (value === undefined || value === null) return fallback;
  if (typeof value !== "number" || !Number.isFinite(value)) throw new Error(`${key} must be a finite number`);
  if (value < min || value > max) throw new Error(`${key} must be between ${min} and ${max}`);
  return value;
}

function finiteNumberArg(args: Record<string, unknown>, key: string): number {
  const value = args[key];
  if (typeof value !== "number" || !Number.isFinite(value)) throw new Error(`${key} must be a finite number`);
  return value;
}

function redactBrowserUrl(value: string): string {
  try {
    const url = new URL(value);
    if (url.search) url.search = "?[redacted]";
    if (url.hash) url.hash = "#[redacted]";
    return url.toString();
  } catch {
    return value.length > 180 ? `${value.slice(0, 180)}...` : value;
  }
}
