export type ManagedEventSocketHandle = {
  close(): void;
};

export type ManagedEventWebSocket = {
  readonly readyState: number;
  onopen: ((event: Event) => void) | null;
  onmessage: ((event: MessageEvent) => void) | null;
  onerror: ((event: Event) => void) | null;
  onclose: ((event: CloseEvent) => void) | null;
  send(data: string): void;
  close(code?: number, reason?: string): void;
};

export type ManagedEventWebSocketFactory = (
  url: string,
  protocols: string[],
) => ManagedEventWebSocket;

export type ManagedEventSocketOptions = {
  reconnectDelayMs?: (attempt: number) => number;
};

type ManagedEventSocketInput = {
  realtimeUrl: string;
  httpUrl: string;
  authorizationToken: string;
  channels: string[];
  onEvent: (event: unknown) => void;
  onReady?: () => void;
  onError?: (error: unknown) => void;
};

const SOCKET_OPEN = 1;
const CONNECTION_ACK_TIMEOUT_MS = 15_000;
const SUBSCRIPTION_ACK_TIMEOUT_MS = 15_000;
const DEFAULT_KEEP_ALIVE_TIMEOUT_MS = 5 * 60_000;
const KEEP_ALIVE_CHECK_INTERVAL_MS = 5_000;
const MAX_RECONNECT_DELAY_MS = 10_000;

export function openManagedEventSocket(
  input: ManagedEventSocketInput,
  webSocketFactory: ManagedEventWebSocketFactory = (url, protocols) =>
    new WebSocket(url, protocols),
  options: ManagedEventSocketOptions = {},
): ManagedEventSocketHandle {
  const connection = new ManagedEventConnection(
    input,
    webSocketFactory,
    options.reconnectDelayMs ?? defaultReconnectDelayMs,
  );
  connection.open();
  return { close: () => connection.close() };
}

class ManagedEventConnection {
  private socket: ManagedEventWebSocket | null = null;
  private closed = false;
  private generation = 0;
  private reconnectAttempt = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private connectionAckTimer: ReturnType<typeof setTimeout> | null = null;
  private subscriptionAckTimer: ReturnType<typeof setTimeout> | null = null;
  private keepAliveTimer: ReturnType<typeof setInterval> | null = null;
  private keepAliveTimeoutMs = DEFAULT_KEEP_ALIVE_TIMEOUT_MS;
  private lastKeepAliveAt = Date.now();
  private ready = false;
  private readonly subscriptionChannels = new Map<string, string>();
  private readonly acknowledgedSubscriptions = new Set<string>();

  constructor(
    private readonly input: ManagedEventSocketInput,
    private readonly webSocketFactory: ManagedEventWebSocketFactory,
    private readonly reconnectDelayMs: (attempt: number) => number,
  ) {}

  open(): void {
    this.connect();
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.clearTimers();
    const socket = this.socket;
    this.socket = null;
    if (!socket) return;
    if (socket.readyState === SOCKET_OPEN) {
      for (const id of this.subscriptionChannels.keys()) {
        socket.send(JSON.stringify({ type: "unsubscribe", id }));
      }
    }
    socket.onclose = null;
    socket.onerror = null;
    socket.onmessage = null;
    socket.onopen = null;
    socket.close(1000, "Client closed");
  }

  private connect(): void {
    if (this.closed) return;
    const generation = ++this.generation;
    this.subscriptionChannels.clear();
    this.acknowledgedSubscriptions.clear();
    this.ready = false;
    this.clearConnectionTimers();

    let socket: ManagedEventWebSocket;
    try {
      socket = this.webSocketFactory(this.input.realtimeUrl, [
        "aws-appsync-event-ws",
        `header-${base64Url(
          JSON.stringify({
            Authorization: this.input.authorizationToken,
            host: new URL(this.input.httpUrl).host,
          }),
        )}`,
      ]);
    } catch (error) {
      this.reportError(error);
      this.scheduleReconnect();
      return;
    }
    this.socket = socket;
    socket.onopen = () => {
      if (!this.isCurrent(socket, generation)) return;
      socket.send(JSON.stringify({ type: "connection_init" }));
      this.connectionAckTimer = setTimeout(() => {
        this.failConnection(new Error("Team chat realtime connection acknowledgement timed out."));
      }, CONNECTION_ACK_TIMEOUT_MS);
    };
    socket.onmessage = (event) => {
      if (this.isCurrent(socket, generation)) this.handleMessage(socket, event);
    };
    socket.onerror = () => {
      if (!this.isCurrent(socket, generation)) return;
      this.failConnection(new Error("Team chat realtime socket failed."), false);
    };
    socket.onclose = (event) => {
      if (!this.isCurrent(socket, generation)) return;
      this.socket = null;
      this.clearConnectionTimers();
      if (!this.closed) {
        if (event.code === 4401 || event.code === 4403) {
          this.reportError(new Error("Team chat realtime authorization expired."));
        }
        this.scheduleReconnect();
      }
    };
  }

  private handleMessage(socket: ManagedEventWebSocket, event: MessageEvent): void {
    if (typeof event.data !== "string") return;
    let message: Record<string, unknown>;
    try {
      const parsed = JSON.parse(event.data);
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return;
      message = parsed as Record<string, unknown>;
    } catch {
      this.reportError(new Error("Team chat realtime returned an invalid frame."));
      return;
    }

    const type = typeof message.type === "string" ? message.type : "";
    if (type === "connection_ack") {
      if (this.connectionAckTimer) clearTimeout(this.connectionAckTimer);
      this.connectionAckTimer = null;
      this.keepAliveTimeoutMs = validTimeout(message.connectionTimeoutMs);
      this.lastKeepAliveAt = Date.now();
      this.startKeepAliveMonitor();
      this.subscribe(socket);
      return;
    }
    if (type === "ka") {
      this.lastKeepAliveAt = Date.now();
      return;
    }
    if (type === "subscribe_success") {
      const id = typeof message.id === "string" ? message.id : "";
      if (!this.subscriptionChannels.has(id)) return;
      this.acknowledgedSubscriptions.add(id);
      this.markReadyWhenSubscribed();
      return;
    }
    if (type === "data") {
      this.lastKeepAliveAt = Date.now();
      if (typeof message.event !== "string") return;
      try {
        this.input.onEvent(JSON.parse(message.event));
      } catch {
        this.reportError(new Error("Team chat realtime returned an invalid event."));
      }
      return;
    }
    if (type === "connection_error" || type === "subscribe_error") {
      const error = protocolError(message);
      this.reportError(error);
      if (type === "connection_error") {
        this.failConnection(error, false);
      } else {
        const id = typeof message.id === "string" ? message.id : "";
        this.subscriptionChannels.delete(id);
        this.acknowledgedSubscriptions.delete(id);
        this.markReadyWhenSubscribed();
      }
    }
  }

  private subscribe(socket: ManagedEventWebSocket): void {
    const authorization = {
      Authorization: this.input.authorizationToken,
      host: new URL(this.input.httpUrl).host,
    };
    for (const channel of Array.from(new Set(this.input.channels))) {
      const id = operationId();
      this.subscriptionChannels.set(id, channel);
      socket.send(
        JSON.stringify({
          type: "subscribe",
          id,
          channel,
          authorization,
        }),
      );
    }
    this.subscriptionAckTimer = setTimeout(() => {
      this.failConnection(new Error("Team chat realtime subscription acknowledgement timed out."));
    }, SUBSCRIPTION_ACK_TIMEOUT_MS);
  }

  private startKeepAliveMonitor(): void {
    if (this.keepAliveTimer) clearInterval(this.keepAliveTimer);
    this.keepAliveTimer = setInterval(() => {
      if (Date.now() - this.lastKeepAliveAt <= this.keepAliveTimeoutMs) return;
      this.failConnection(new Error("Team chat realtime connection became stale."));
    }, KEEP_ALIVE_CHECK_INTERVAL_MS);
  }

  private markReadyWhenSubscribed(): void {
    if (
      this.ready ||
      this.subscriptionChannels.size === 0 ||
      this.acknowledgedSubscriptions.size !== this.subscriptionChannels.size
    ) {
      return;
    }
    this.ready = true;
    if (this.subscriptionAckTimer) clearTimeout(this.subscriptionAckTimer);
    this.subscriptionAckTimer = null;
    this.reconnectAttempt = 0;
    this.input.onReady?.();
  }

  private failConnection(error: Error, report = true): void {
    if (this.closed) return;
    if (report) this.reportError(error);
    const socket = this.socket;
    this.clearConnectionTimers();
    if (!socket) {
      this.scheduleReconnect();
      return;
    }
    socket.close(4000, "Reconnect");
  }

  private scheduleReconnect(): void {
    if (this.closed || this.reconnectTimer) return;
    const delay = Math.max(0, Math.floor(this.reconnectDelayMs(this.reconnectAttempt)));
    this.reconnectAttempt += 1;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.connect();
    }, delay);
  }

  private reportError(error: unknown): void {
    this.input.onError?.(error);
  }

  private isCurrent(socket: ManagedEventWebSocket, generation: number): boolean {
    return !this.closed && this.socket === socket && this.generation === generation;
  }

  private clearConnectionTimers(): void {
    if (this.connectionAckTimer) clearTimeout(this.connectionAckTimer);
    if (this.subscriptionAckTimer) clearTimeout(this.subscriptionAckTimer);
    if (this.keepAliveTimer) clearInterval(this.keepAliveTimer);
    this.connectionAckTimer = null;
    this.subscriptionAckTimer = null;
    this.keepAliveTimer = null;
  }

  private clearTimers(): void {
    this.clearConnectionTimers();
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
  }
}

function defaultReconnectDelayMs(attempt: number): number {
  const ceiling = Math.min(MAX_RECONNECT_DELAY_MS, 500 * 2 ** Math.min(attempt, 5));
  return Math.max(100, Math.floor(Math.random() * ceiling));
}

function base64Url(value: string): string {
  const bytes = new TextEncoder().encode(value);
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
}

function operationId(): string {
  return (
    globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random().toString(36).slice(2)}`
  );
}

function validTimeout(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0
    ? value
    : DEFAULT_KEEP_ALIVE_TIMEOUT_MS;
}

function protocolError(message: Record<string, unknown>): Error {
  const errors = Array.isArray(message.errors) ? message.errors : [];
  const first = errors[0];
  if (first && typeof first === "object") {
    const candidate = first as { errorType?: unknown; message?: unknown };
    const type = typeof candidate.errorType === "string" ? candidate.errorType : "RealtimeError";
    const detail = typeof candidate.message === "string" ? candidate.message : "Request failed";
    return new Error(`${type}: ${detail}`);
  }
  return new Error("Team chat realtime request failed.");
}
