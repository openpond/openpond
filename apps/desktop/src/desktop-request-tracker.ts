export type DesktopRequestTrackerOptions = {
  slowThresholdMs?: number;
  stuckThresholdMs?: number;
  maxRecentSlowRequests?: number;
  now?: () => number;
  dateNow?: () => string;
};

export type DesktopRequestDiagnosticsSnapshot = {
  slowThresholdMs: number;
  stuckThresholdMs: number;
  pendingCount: number;
  recentSlowRequests: DesktopRequestSummary[];
  stuckRequests: DesktopRequestSummary[];
};

export type DesktopRequestSummary = {
  id: number;
  channel: string;
  startedAt: string;
  durationMs: number;
  status: "pending" | "ok" | "error";
  error?: string;
};

type PendingRequest = {
  id: number;
  channel: string;
  startedAt: string;
  startedAtMs: number;
};

type RequestHandler<Args extends unknown[], Result> = (
  ...args: Args
) => Result | Promise<Result>;

export class DesktopRequestTracker {
  private readonly slowThresholdMs: number;
  private readonly stuckThresholdMs: number;
  private readonly maxRecentSlowRequests: number;
  private readonly now: () => number;
  private readonly dateNow: () => string;
  private nextId = 1;
  private readonly pending = new Map<number, PendingRequest>();
  private readonly recentSlowRequests: DesktopRequestSummary[] = [];

  constructor(options: DesktopRequestTrackerOptions = {}) {
    this.slowThresholdMs = Math.max(1, Math.trunc(options.slowThresholdMs ?? 2_000));
    this.stuckThresholdMs = Math.max(this.slowThresholdMs, Math.trunc(options.stuckThresholdMs ?? 10_000));
    this.maxRecentSlowRequests = Math.max(1, Math.trunc(options.maxRecentSlowRequests ?? 50));
    this.now = options.now ?? (() => Date.now());
    this.dateNow = options.dateNow ?? (() => new Date().toISOString());
  }

  wrap<Args extends unknown[], Result>(
    channel: string,
    handler: RequestHandler<Args, Result>,
  ): RequestHandler<Args, Promise<Awaited<Result>>> {
    return async (...args: Args): Promise<Awaited<Result>> => {
      const request = this.start(channel);
      try {
        const result = await handler(...args);
        this.finish(request, "ok");
        return result as Awaited<Result>;
      } catch (error) {
        this.finish(request, "error", error);
        throw error;
      }
    };
  }

  snapshot(options: { excludeChannels?: string[] } = {}): DesktopRequestDiagnosticsSnapshot {
    const excluded = new Set(options.excludeChannels ?? []);
    const now = this.now();
    const pending = [...this.pending.values()].filter((request) => !excluded.has(request.channel));
    return {
      slowThresholdMs: this.slowThresholdMs,
      stuckThresholdMs: this.stuckThresholdMs,
      pendingCount: pending.length,
      recentSlowRequests: this.recentSlowRequests.filter((request) => !excluded.has(request.channel)),
      stuckRequests: pending
        .map((request) => this.summary(request, "pending", now))
        .filter((request) => request.durationMs >= this.stuckThresholdMs),
    };
  }

  private start(channel: string): PendingRequest {
    const startedAtMs = this.now();
    const request = {
      id: this.nextId++,
      channel,
      startedAt: this.dateNow(),
      startedAtMs,
    };
    this.pending.set(request.id, request);
    return request;
  }

  private finish(request: PendingRequest, status: "ok" | "error", error?: unknown): void {
    this.pending.delete(request.id);
    const summary = this.summary(request, status, this.now(), error);
    if (summary.durationMs < this.slowThresholdMs) return;
    this.recentSlowRequests.push(summary);
    if (this.recentSlowRequests.length > this.maxRecentSlowRequests) {
      this.recentSlowRequests.splice(0, this.recentSlowRequests.length - this.maxRecentSlowRequests);
    }
  }

  private summary(
    request: PendingRequest,
    status: DesktopRequestSummary["status"],
    now: number,
    error?: unknown,
  ): DesktopRequestSummary {
    return {
      id: request.id,
      channel: request.channel,
      startedAt: request.startedAt,
      durationMs: Math.max(0, Math.round(now - request.startedAtMs)),
      status,
      ...(error ? { error: errorMessage(error) } : {}),
    };
  }
}

function errorMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.length > 500 ? `${message.slice(0, 500)}...` : message;
}
