import type { BrowserBounds } from "./desktop-browser-types.js";

export type BrowserHarnessToolName =
  | "openpond_browser_open"
  | "openpond_browser_snapshot"
  | "openpond_browser_move_cursor"
  | "openpond_browser_click"
  | "openpond_browser_type"
  | "openpond_browser_key"
  | "openpond_browser_scroll";

export type BrowserHarnessOperation =
  | "open"
  | "snapshot"
  | "moveCursor"
  | "click"
  | "typeText"
  | "pressKey"
  | "scroll";

export const BROWSER_HARNESS_KEYS = [
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

export type BrowserHarnessKey = (typeof BROWSER_HARNESS_KEYS)[number];

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

export type BrowserHarnessInput =
  | BrowserHarnessOpenInput
  | BrowserHarnessSnapshotInput
  | BrowserHarnessMoveCursorInput
  | BrowserHarnessClickInput
  | BrowserHarnessTypeTextInput
  | BrowserHarnessKeyInput
  | BrowserHarnessScrollInput;

export type BrowserHarnessRequest = {
  id: string;
  operation: BrowserHarnessOperation;
  toolName: BrowserHarnessToolName;
  createdAt: string;
  deadlineAt: string;
  input: Record<string, unknown>;
};

export type ParsedBrowserHarnessRequest =
  | (BrowserHarnessRequest & { operation: "open"; toolName: "openpond_browser_open"; input: BrowserHarnessOpenInput })
  | (BrowserHarnessRequest & { operation: "snapshot"; toolName: "openpond_browser_snapshot"; input: BrowserHarnessSnapshotInput })
  | (BrowserHarnessRequest & { operation: "moveCursor"; toolName: "openpond_browser_move_cursor"; input: BrowserHarnessMoveCursorInput })
  | (BrowserHarnessRequest & { operation: "click"; toolName: "openpond_browser_click"; input: BrowserHarnessClickInput })
  | (BrowserHarnessRequest & { operation: "typeText"; toolName: "openpond_browser_type"; input: BrowserHarnessTypeTextInput })
  | (BrowserHarnessRequest & { operation: "pressKey"; toolName: "openpond_browser_key"; input: BrowserHarnessKeyInput })
  | (BrowserHarnessRequest & { operation: "scroll"; toolName: "openpond_browser_scroll"; input: BrowserHarnessScrollInput });

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

export type BrowserHarnessResult = {
  ok: boolean;
  output: string;
  data?: Record<string, unknown>;
  metadata?: BrowserHarnessResponseMetadata;
};

export type BrowserHarnessSnapshotTarget = {
  ref: string;
  role: string;
  name: string;
  tag: string;
  bounds: BrowserBounds;
  text?: string;
  value?: string;
  type?: string;
  href?: string;
  disabled?: boolean;
  checked?: boolean;
  selected?: boolean;
  editable?: boolean;
};

export type BrowserHarnessSnapshotData = {
  snapshotId: string;
  tabId: string;
  url: string;
  title: string;
  viewport: {
    width: number;
    height: number;
    scrollX: number;
    scrollY: number;
  };
  targets: BrowserHarnessSnapshotTarget[];
};

export type BrowserHarnessResolvedTarget = {
  point: BrowserHarnessPoint;
  bounds: BrowserBounds;
  ref?: string;
  role?: string;
  name?: string;
  tag?: string;
};
