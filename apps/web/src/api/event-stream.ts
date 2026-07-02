import type { RuntimeEvent } from "@openpond/contracts";

export type RuntimeEventStreamConnection = {
  serverUrl: string;
  token: string;
};

export type RuntimeEventStreamRequest = {
  url: string;
  init: RequestInit;
};

export type RuntimeEventStreamHandle = {
  close(): void;
  isOpen(): boolean;
};

export function runtimeEventStreamRequest(
  connection: RuntimeEventStreamConnection,
  signal?: AbortSignal,
): RuntimeEventStreamRequest {
  const headers = new Headers();
  headers.set("Accept", "text/event-stream");
  headers.set("Authorization", `Bearer ${connection.token}`);
  return {
    url: `${connection.serverUrl.replace(/\/$/, "")}/v1/events`,
    init: { headers, signal },
  };
}

export function runtimeEventReconnectDelayMs(attempt: number): number {
  return Math.min(500 * 2 ** Math.max(0, attempt), 10_000);
}

export async function readRuntimeEventStream(
  response: Response,
  onEvent: (event: RuntimeEvent) => void,
  onReady?: () => void,
  signal?: AbortSignal,
): Promise<void> {
  validateRuntimeEventResponse(response);
  const reader = response.body!.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  while (!signal?.aborted) {
    const { done, value } = await reader.read();
    if (done) {
      buffer += decoder.decode();
      break;
    }
    buffer += decoder.decode(value, { stream: true });
    let boundary = buffer.indexOf("\n\n");
    while (boundary >= 0) {
      const raw = buffer.slice(0, boundary);
      buffer = buffer.slice(boundary + 2);
      handleRuntimeEventFrame(raw, onEvent, onReady);
      boundary = buffer.indexOf("\n\n");
    }
  }
  if (!signal?.aborted && buffer.trim()) {
    handleRuntimeEventFrame(buffer, onEvent, onReady);
  }
}

export function validateRuntimeEventResponse(response: Response): void {
  if (!response.ok) {
    throw new Error(`event stream failed: ${response.status} ${response.statusText || "HTTP error"}`);
  }
  if (!response.body) {
    throw new Error("event stream did not return a response body");
  }
}

export function openEventStream(
  connection: RuntimeEventStreamConnection,
  onEvent: (event: RuntimeEvent) => void,
  onError: (error: unknown) => void,
  onOpen?: () => void,
  input: {
    fetchImpl?: typeof fetch;
    reconnectDelayMs?: (attempt: number) => number;
  } = {},
): RuntimeEventStreamHandle {
  const controller = new AbortController();
  const fetchImpl = input.fetchImpl ?? fetch;
  const reconnectDelayMs = input.reconnectDelayMs ?? runtimeEventReconnectDelayMs;
  let open = false;

  void (async () => {
    let attempt = 0;
    while (!controller.signal.aborted) {
      try {
        const request = runtimeEventStreamRequest(connection, controller.signal);
        const response = await fetchImpl(request.url, request.init);
        validateRuntimeEventResponse(response);
        open = true;
        attempt = 0;
        onOpen?.();
        await readRuntimeEventStream(response, onEvent, onOpen, controller.signal);
        open = false;
        if (controller.signal.aborted) break;
        throw new Error("event stream ended");
      } catch (error) {
        open = false;
        if (controller.signal.aborted) break;
        onError(error);
        await abortableDelay(reconnectDelayMs(attempt), controller.signal);
        attempt += 1;
      }
    }
  })().catch(() => undefined);

  return {
    close() {
      controller.abort();
    },
    isOpen() {
      return open;
    },
  };
}

function handleRuntimeEventFrame(
  raw: string,
  onEvent: (event: RuntimeEvent) => void,
  onReady?: () => void,
): void {
  let eventName = "message";
  const data: string[] = [];
  for (const line of raw.split("\n")) {
    if (line.startsWith(":")) continue;
    if (line.startsWith("event: ")) eventName = line.slice(7).trim();
    if (line.startsWith("data: ")) data.push(line.slice(6));
  }

  if (eventName === "ready") {
    onReady?.();
    return;
  }
  if (eventName !== "runtime" || data.length === 0) return;
  try {
    onEvent(JSON.parse(data.join("\n")) as RuntimeEvent);
  } catch {
    // Ignore malformed frames; the stream should continue processing later events.
  }
}

async function abortableDelay(ms: number, signal: AbortSignal): Promise<void> {
  if (ms <= 0 || signal.aborted) return;
  await new Promise<void>((resolve) => {
    const timer = globalThis.setTimeout(resolve, ms);
    signal.addEventListener(
      "abort",
      () => {
        globalThis.clearTimeout(timer);
        resolve();
      },
      { once: true },
    );
  });
}
