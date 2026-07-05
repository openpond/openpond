import { randomUUID } from "node:crypto";
import type { IncomingMessage } from "node:http";
import type {
  BrowserHarnessClickInput,
  BrowserHarnessKeyInput,
  BrowserHarnessMoveCursorInput,
  BrowserHarnessOpenInput,
  BrowserHarnessResponseMetadata,
  BrowserHarnessScrollInput,
  BrowserHarnessSnapshotInput,
  BrowserHarnessToolExecutor,
  BrowserHarnessToolName,
  BrowserHarnessToolResult,
  BrowserHarnessTypeTextInput,
} from "./browser-tool-registry.js";

type BrowserControlOperation =
  | "open"
  | "snapshot"
  | "moveCursor"
  | "click"
  | "typeText"
  | "pressKey"
  | "scroll";

export type BrowserControlRequest = {
  id: string;
  operation: BrowserControlOperation;
  toolName: BrowserHarnessToolName;
  createdAt: string;
  deadlineAt: string;
  input: Record<string, unknown>;
};

type PendingBrowserControlRequest = {
  request: BrowserControlRequest;
  resolve: (result: BrowserHarnessToolResult) => void;
  timeout: NodeJS.Timeout;
};

export type BrowserControlQueue = {
  executor: BrowserHarnessToolExecutor;
  registerDesktopExecutor(payload: unknown): { ok: true; registered: true; instanceId: string };
  claimNext(request: IncomingMessage): Promise<{ ok: true; request: BrowserControlRequest | null }>;
  completeRequest(request: IncomingMessage, requestId: string, payload: unknown): { ok: true };
  status(): {
    connected: boolean;
    instanceId: string | null;
    pendingCount: number;
    inFlightCount: number;
    lastSeenAt: string | null;
  };
  close(): void;
};

const DEFAULT_BROWSER_CONTROL_TIMEOUT_MS = 30_000;
const DESKTOP_HEARTBEAT_TTL_MS = 35_000;
const LONG_POLL_TIMEOUT_MS = 25_000;
const MAX_PENDING_BROWSER_REQUESTS = 20;

export function createBrowserControlQueue(input: {
  now?: () => number;
  timeoutMs?: number;
} = {}): BrowserControlQueue {
  const now = input.now ?? Date.now;
  const timeoutMs = input.timeoutMs ?? DEFAULT_BROWSER_CONTROL_TIMEOUT_MS;
  const pending: PendingBrowserControlRequest[] = [];
  const inFlight = new Map<string, PendingBrowserControlRequest>();
  const waiters = new Set<() => void>();
  let desktop:
    | {
        executorToken: string;
        instanceId: string;
        lastSeenAtMs: number;
      }
    | null = null;
  let closed = false;

  const executor: BrowserHarnessToolExecutor = {
    available: () => isDesktopConnected(),
    open: (request) => enqueue("open", "openpond_browser_open", request),
    snapshot: (request) => enqueue("snapshot", "openpond_browser_snapshot", request),
    moveCursor: (request) => enqueue("moveCursor", "openpond_browser_move_cursor", request),
    click: (request) => enqueue("click", "openpond_browser_click", request),
    typeText: (request) => enqueue("typeText", "openpond_browser_type", request),
    pressKey: (request) => enqueue("pressKey", "openpond_browser_key", request),
    scroll: (request) => enqueue("scroll", "openpond_browser_scroll", request),
  };

  function registerDesktopExecutor(payload: unknown): { ok: true; registered: true; instanceId: string } {
    const record = asRecord(payload);
    const executorToken = stringField(record, "executorToken");
    const instanceId = optionalStringField(record, "instanceId") ?? `desktop_${randomUUID()}`;
    if (!executorToken) throw new Error("executorToken is required");
    desktop = {
      executorToken,
      instanceId,
      lastSeenAtMs: now(),
    };
    wakeWaiters();
    return { ok: true, registered: true, instanceId };
  }

  async function claimNext(request: IncomingMessage): Promise<{ ok: true; request: BrowserControlRequest | null }> {
    authenticateDesktop(request);
    touchDesktop();
    const immediate = pending.shift();
    if (immediate) {
      inFlight.set(immediate.request.id, immediate);
      return { ok: true, request: immediate.request };
    }

    await new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, LONG_POLL_TIMEOUT_MS);
      const waiter = () => {
        clearTimeout(timer);
        waiters.delete(waiter);
        resolve();
      };
      waiters.add(waiter);
      if (pending.length > 0) waiter();
    });

    authenticateDesktop(request);
    touchDesktop();
    const next = pending.shift();
    if (next) inFlight.set(next.request.id, next);
    return { ok: true, request: next?.request ?? null };
  }

  function completeRequest(request: IncomingMessage, requestId: string, payload: unknown): { ok: true } {
    authenticateDesktop(request);
    touchDesktop();
    const item = inFlight.get(requestId);
    if (!item) throw new Error("Browser control request is not pending.");
    inFlight.delete(requestId);
    clearTimeout(item.timeout);
    item.resolve(parseBrowserControlResult(item.request.toolName, payload));
    return { ok: true };
  }

  function status() {
    return {
      connected: isDesktopConnected(),
      instanceId: desktop?.instanceId ?? null,
      pendingCount: pending.length,
      inFlightCount: inFlight.size,
      lastSeenAt: desktop ? new Date(desktop.lastSeenAtMs).toISOString() : null,
    };
  }

  function close(): void {
    closed = true;
    for (const waiter of waiters) waiter();
    waiters.clear();
    while (pending.length > 0) {
      const item = pending.shift();
      if (!item) continue;
      clearTimeout(item.timeout);
      item.resolve({
        ok: false,
        action: item.request.toolName,
        output: "Browser control queue closed.",
      });
    }
    for (const item of inFlight.values()) {
      clearTimeout(item.timeout);
      item.resolve({
        ok: false,
        action: item.request.toolName,
        output: "Browser control queue closed.",
      });
    }
    inFlight.clear();
  }

  function enqueue(
    operation: BrowserControlOperation,
    toolName: BrowserHarnessToolName,
    input:
      | BrowserHarnessOpenInput
      | BrowserHarnessSnapshotInput
      | BrowserHarnessMoveCursorInput
      | BrowserHarnessClickInput
      | BrowserHarnessTypeTextInput
      | BrowserHarnessKeyInput
      | BrowserHarnessScrollInput,
  ): Promise<BrowserHarnessToolResult> {
    if (closed) {
      return Promise.resolve({
        ok: false,
        action: toolName,
        output: "Browser control queue is closed.",
      });
    }
    if (!isDesktopConnected()) {
      return Promise.resolve({
        ok: false,
        action: toolName,
        output: "Desktop browser executor is not connected.",
      });
    }
    if (pending.length >= MAX_PENDING_BROWSER_REQUESTS) {
      return Promise.resolve({
        ok: false,
        action: toolName,
        output: "Too many pending browser control requests.",
      });
    }

    const createdAtMs = now();
    const id = `browser_req_${randomUUID()}`;
    const request: BrowserControlRequest = {
      id,
      operation,
      toolName,
      createdAt: new Date(createdAtMs).toISOString(),
      deadlineAt: new Date(createdAtMs + timeoutMs).toISOString(),
      input: serializeBrowserInput(input),
    };
    return new Promise((resolve) => {
      const timeout = setTimeout(() => {
        const index = pending.findIndex((item) => item.request.id === id);
        if (index >= 0) pending.splice(index, 1);
        inFlight.delete(id);
        resolve({
          ok: false,
          action: toolName,
          output: "Timed out waiting for desktop browser executor.",
        });
      }, timeoutMs);
      pending.push({ request, resolve, timeout });
      wakeWaiters();
      input.signal.addEventListener(
        "abort",
        () => {
          const index = pending.findIndex((item) => item.request.id === id);
          if (index >= 0) pending.splice(index, 1);
          inFlight.delete(id);
          clearTimeout(timeout);
          resolve({
            ok: false,
            action: toolName,
            output: "Browser control request was interrupted.",
          });
        },
        { once: true },
      );
    });
  }

  function authenticateDesktop(request: IncomingMessage): void {
    if (!desktop) throw new Error("Desktop browser executor is not registered.");
    const token = headerValue(request.headers["x-openpond-desktop-executor-token"]);
    if (token !== desktop.executorToken) throw new Error("Unauthorized desktop browser executor.");
  }

  function touchDesktop(): void {
    if (desktop) desktop.lastSeenAtMs = now();
  }

  function isDesktopConnected(): boolean {
    return Boolean(desktop && now() - desktop.lastSeenAtMs <= DESKTOP_HEARTBEAT_TTL_MS);
  }

  function wakeWaiters(): void {
    for (const waiter of waiters) waiter();
    waiters.clear();
  }

  return {
    executor,
    registerDesktopExecutor,
    claimNext,
    completeRequest,
    status,
    close,
  };
}

function serializeBrowserInput(input: { signal: AbortSignal } & Record<string, unknown>): Record<string, unknown> {
  const { signal: _signal, ...rest } = input;
  return rest;
}

function parseBrowserControlResult(
  toolName: BrowserHarnessToolName,
  payload: unknown,
): BrowserHarnessToolResult {
  const record = asRecord(payload);
  if (!record) {
    return {
      ok: false,
      action: toolName,
      output: "Browser action returned an invalid result.",
    };
  }
  const ok = record.ok === true;
  const output = typeof record.output === "string" && record.output.trim()
    ? record.output.trim()
    : ok
      ? "Browser action completed."
      : "Browser action failed.";
  const data = asRecord(record.data) ?? undefined;
  const metadata = parseBrowserMetadata(record.metadata);
  return {
    ok,
    action: toolName,
    output,
    ...(data ? { data } : {}),
    ...(metadata ? { metadata } : {}),
  };
}

function parseBrowserMetadata(value: unknown): BrowserHarnessResponseMetadata | undefined {
  const record = asRecord(value);
  if (!record) return undefined;
  const cursor = asRecord(record.cursor);
  const screenshot = asRecord(record.screenshot);
  return {
    ...(typeof record.activeTabId === "string" ? { activeTabId: record.activeTabId } : {}),
    ...(typeof record.title === "string" ? { title: record.title } : {}),
    ...(typeof record.url === "string" ? { url: record.url } : {}),
    ...(Array.isArray(record.openTabIds)
      ? { openTabIds: record.openTabIds.filter((item): item is string => typeof item === "string") }
      : {}),
    ...(cursor && typeof cursor.x === "number" && typeof cursor.y === "number"
      ? { cursor: { x: cursor.x, y: cursor.y } }
      : {}),
    ...(typeof record.snapshotId === "string" ? { snapshotId: record.snapshotId } : {}),
    ...(screenshot && typeof screenshot.tabId === "string" && typeof screenshot.url === "string"
      ? { screenshot: { tabId: screenshot.tabId, url: screenshot.url } }
      : {}),
  };
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function stringField(record: Record<string, unknown> | null, key: string): string {
  const value = record?.[key];
  if (typeof value !== "string" || !value.trim()) return "";
  return value.trim();
}

function optionalStringField(record: Record<string, unknown> | null, key: string): string | null {
  const value = record?.[key];
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function headerValue(value: string | string[] | undefined): string | null {
  if (Array.isArray(value)) return value[0] ?? null;
  return value ?? null;
}
