import type { RuntimeEvent } from "@openpond/contracts";

export type TerminalEventStreamStatus =
  | { state: "connecting"; attempt: number }
  | { state: "connected"; attempt: number }
  | { state: "disconnected"; attempt: number; message: string; nextDelayMs: number };

export type TerminalEventStreamRequest = {
  url: string;
  init: RequestInit;
};

export type TerminalEventStreamController = AbortController & {
  ready: Promise<void>;
  switchSession(sessionId: string | null): Promise<void>;
};

export function terminalEventStreamRequest(
  server: string,
  token: string,
  signal?: AbortSignal,
  options: { afterSequence?: number; sessionId?: string | null } = {},
): TerminalEventStreamRequest {
  const headers = new Headers();
  headers.set("Accept", "text/event-stream");
  headers.set("Authorization", `Bearer ${token}`);
  const url = new URL(`${server.replace(/\/$/, "")}/v1/events`);
  if ((options.afterSequence ?? 0) > 0) url.searchParams.set("afterSequence", String(options.afterSequence));
  if (options.sessionId) url.searchParams.set("sessionId", options.sessionId);
  return {
    url: url.toString(),
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
  onReady?: () => void,
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
      handleTerminalEventFrame(raw, activeSessionId, onEvent, onReady);
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
}): Promise<TerminalEventStreamController> {
  const controller = new AbortController() as TerminalEventStreamController;
  const fetchImpl = input.fetchImpl ?? fetch;
  const reconnectDelayMs = input.reconnectDelayMs ?? terminalEventReconnectDelayMs;
  const initialReady = createDeferred();
  let sessionReady = initialReady;
  let requestedSessionId = input.activeSessionId();
  let generation = 0;
  let readyGeneration = -1;
  let activeRequest: AbortController | null = null;
  controller.ready = initialReady.promise;
  controller.switchSession = (sessionId) => {
    if (controller.signal.aborted) return Promise.reject(new Error("event stream is closed"));
    if (sessionId === requestedSessionId && readyGeneration === generation) return Promise.resolve();
    requestedSessionId = sessionId;
    generation += 1;
    sessionReady.reject(new Error("event stream session changed before becoming ready"));
    sessionReady = createDeferred();
    activeRequest?.abort();
    return sessionReady.promise;
  };
  controller.signal.addEventListener(
    "abort",
    () => {
      activeRequest?.abort();
      const error = new Error("event stream aborted before connecting");
      initialReady.reject(error);
      sessionReady.reject(error);
    },
    { once: true },
  );
  controller.ready.catch(() => undefined);
  let lastAppliedSequence = 0;
  void (async () => {
    let attempt = 0;
    while (!controller.signal.aborted) {
      const requestGeneration = generation;
      const requestSessionId = requestedSessionId;
      const requestController = new AbortController();
      activeRequest = requestController;
      input.onStatus?.({ state: "connecting", attempt });
      try {
        const request = terminalEventStreamRequest(input.server, input.token, requestController.signal, {
          afterSequence: lastAppliedSequence,
          sessionId: requestSessionId,
        });
        const response = await fetchImpl(request.url, request.init);
        validateTerminalEventResponse(response);
        input.onStatus?.({ state: "connected", attempt });
        await readTerminalEventStream(
          response,
          () => requestSessionId,
          (event) => {
            const sequence = event.sequence ?? 0;
            if (sequence > 0 && sequence <= lastAppliedSequence) return;
            if (sequence > 0) lastAppliedSequence = sequence;
            input.onEvent(event);
          },
          requestController.signal,
          () => {
            if (requestGeneration !== generation) return;
            readyGeneration = requestGeneration;
            initialReady.resolve();
            sessionReady.resolve();
          },
        );
        if (controller.signal.aborted) break;
        if (requestGeneration !== generation) {
          attempt = 0;
          continue;
        }
        throw new Error("event stream ended");
      } catch (error) {
        if (controller.signal.aborted) break;
        if (requestGeneration !== generation) {
          attempt = 0;
          continue;
        }
        const message = error instanceof Error ? error.message : String(error);
        const nextDelayMs = reconnectDelayMs(attempt);
        input.onStatus?.({ state: "disconnected", attempt, message, nextDelayMs });
        await abortableDelay(nextDelayMs, requestController.signal);
        if (requestGeneration !== generation) {
          attempt = 0;
          continue;
        }
        attempt += 1;
      } finally {
        if (activeRequest === requestController) activeRequest = null;
      }
    }
  })().catch(() => undefined);
  return controller;
}

function createDeferred(): {
  promise: Promise<void>;
  resolve(): void;
  reject(error: unknown): void;
} {
  let settled = false;
  let resolvePromise!: () => void;
  let rejectPromise!: (error: unknown) => void;
  const promise = new Promise<void>((resolve, reject) => {
    resolvePromise = resolve;
    rejectPromise = reject;
  });
  promise.catch(() => undefined);
  return {
    promise,
    resolve() {
      if (settled) return;
      settled = true;
      resolvePromise();
    },
    reject(error) {
      if (settled) return;
      settled = true;
      rejectPromise(error);
    },
  };
}

function handleTerminalEventFrame(
  raw: string,
  activeSessionId: () => string | null,
  onEvent: (event: RuntimeEvent) => void,
  onReady?: () => void,
): void {
  const eventName = raw.split("\n").find((line) => line.startsWith("event: "))?.slice(7);
  if (eventName === "ready") {
    onReady?.();
    return;
  }
  const dataLine = raw.split("\n").find((line) => line.startsWith("data: "));
  if (!dataLine) return;
  try {
    const event = JSON.parse(dataLine.slice(6)) as RuntimeEvent;
    if (typeof event.name !== "string") return;
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
