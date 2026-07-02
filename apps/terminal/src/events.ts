import type { RuntimeEvent } from "@openpond/contracts";

export type TerminalEventStreamStatus =
  | { state: "connecting"; attempt: number }
  | { state: "connected"; attempt: number }
  | { state: "disconnected"; attempt: number; message: string; nextDelayMs: number };

export type TerminalEventStreamRequest = {
  url: string;
  init: RequestInit;
};

export function terminalEventStreamRequest(
  server: string,
  token: string,
  signal?: AbortSignal,
): TerminalEventStreamRequest {
  const headers = new Headers();
  headers.set("Accept", "text/event-stream");
  headers.set("Authorization", `Bearer ${token}`);
  return {
    url: `${server.replace(/\/$/, "")}/v1/events`,
    init: { headers, signal },
  };
}

export function terminalEventReconnectDelayMs(attempt: number): number {
  return Math.min(500 * 2 ** Math.max(0, attempt), 10_000);
}

export async function readTerminalEventStream(
  response: Response,
  activeSessionId: () => string | null,
  onEvent: (event: RuntimeEvent) => void,
  signal?: AbortSignal,
): Promise<void> {
  validateTerminalEventResponse(response);
  const reader = response.body!.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  while (!signal?.aborted) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let boundary = buffer.indexOf("\n\n");
    while (boundary >= 0) {
      const raw = buffer.slice(0, boundary);
      buffer = buffer.slice(boundary + 2);
      handleTerminalEventFrame(raw, activeSessionId, onEvent);
      boundary = buffer.indexOf("\n\n");
    }
  }
}

export function validateTerminalEventResponse(response: Response): void {
  if (!response.ok) {
    throw new Error(`event stream failed: ${response.status} ${response.statusText || "HTTP error"}`);
  }
  if (!response.body) {
    throw new Error("event stream did not return a response body");
  }
}

export async function openTerminalEvents(input: {
  server: string;
  token: string;
  activeSessionId: () => string | null;
  onEvent: (event: RuntimeEvent) => void;
  onStatus?: (status: TerminalEventStreamStatus) => void;
  fetchImpl?: typeof fetch;
  reconnectDelayMs?: (attempt: number) => number;
}): Promise<AbortController> {
  const controller = new AbortController();
  const fetchImpl = input.fetchImpl ?? fetch;
  const reconnectDelayMs = input.reconnectDelayMs ?? terminalEventReconnectDelayMs;
  void (async () => {
    let attempt = 0;
    while (!controller.signal.aborted) {
      input.onStatus?.({ state: "connecting", attempt });
      try {
        const request = terminalEventStreamRequest(input.server, input.token, controller.signal);
        const response = await fetchImpl(request.url, request.init);
        input.onStatus?.({ state: "connected", attempt });
        await readTerminalEventStream(response, input.activeSessionId, input.onEvent, controller.signal);
        if (controller.signal.aborted) break;
        throw new Error("event stream ended");
      } catch (error) {
        if (controller.signal.aborted) break;
        const message = error instanceof Error ? error.message : String(error);
        const nextDelayMs = reconnectDelayMs(attempt);
        input.onStatus?.({ state: "disconnected", attempt, message, nextDelayMs });
        await abortableDelay(nextDelayMs, controller.signal);
        attempt += 1;
      }
    }
  })().catch(() => undefined);
  return controller;
}

function handleTerminalEventFrame(
  raw: string,
  activeSessionId: () => string | null,
  onEvent: (event: RuntimeEvent) => void,
): void {
  const dataLine = raw.split("\n").find((line) => line.startsWith("data: "));
  if (!dataLine) return;
  try {
    const event = JSON.parse(dataLine.slice(6)) as RuntimeEvent;
    if (!event.sessionId || event.sessionId === activeSessionId()) onEvent(event);
  } catch {
    // Ignore malformed keepalive frames.
  }
}

async function abortableDelay(ms: number, signal: AbortSignal): Promise<void> {
  if (ms <= 0 || signal.aborted) return;
  await new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, ms);
    signal.addEventListener(
      "abort",
      () => {
        clearTimeout(timer);
        resolve();
      },
      { once: true },
    );
  });
}
