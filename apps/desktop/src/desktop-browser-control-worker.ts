import type { BrowserWindow } from "electron";
import { browserSidebarManagerForWindow } from "./desktop-browser-ipc.js";
import { parseBrowserHarnessRequest } from "./desktop-browser-harness-validation.js";
import type {
  BrowserHarnessRequest,
  BrowserHarnessResult,
  ParsedBrowserHarnessRequest,
} from "./desktop-browser-harness-types.js";
import type { Logger } from "./logger.js";

type DesktopBrowserControlWorkerOptions = {
  serverUrl: string;
  token: string;
  executorToken: string;
  instanceId: string;
  getWindow: () => BrowserWindow | null;
  logger: Logger;
};

type NextResponse = {
  ok?: unknown;
  request?: unknown;
};

const WORKER_RETRY_MS = 2_000;

export class DesktopBrowserControlWorker {
  private controller: AbortController | null = null;
  private loopPromise: Promise<void> | null = null;

  constructor(private readonly options: DesktopBrowserControlWorkerOptions) {}

  start(): void {
    if (this.loopPromise) return;
    this.controller = new AbortController();
    this.loopPromise = this.run(this.controller.signal).finally(() => {
      this.controller = null;
      this.loopPromise = null;
    });
  }

  stop(): void {
    this.controller?.abort();
  }

  matches(input: { serverUrl: string; token: string; executorToken: string }): boolean {
    return (
      this.options.serverUrl === input.serverUrl &&
      this.options.token === input.token &&
      this.options.executorToken === input.executorToken
    );
  }

  private async run(signal: AbortSignal): Promise<void> {
    while (!signal.aborted) {
      try {
        await this.register(signal);
        this.options.logger.info("browser control worker registered", { instanceId: this.options.instanceId });
        await this.poll(signal);
      } catch (error) {
        if (signal.aborted) return;
        this.options.logger.warn("browser control worker loop failed", { error });
        await sleep(WORKER_RETRY_MS, signal);
      }
    }
  }

  private async poll(signal: AbortSignal): Promise<void> {
    while (!signal.aborted) {
      const next = await this.fetchJson<NextResponse>("/v1/desktop/browser-control/next", {
        method: "GET",
        signal,
        desktopExecutor: true,
      });
      if (!next.request) continue;
      await this.handleRequest(next.request, signal);
    }
  }

  private async handleRequest(rawRequest: unknown, signal: AbortSignal): Promise<void> {
    const requestId = requestIdFromUnknown(rawRequest);
    let request: ParsedBrowserHarnessRequest | null = null;
    try {
      request = parseBrowserHarnessRequest(rawRequest);
      const result = await this.executeRequest(request);
      await this.complete(request.id, result, signal);
    } catch (error) {
      const output = error instanceof Error ? error.message : String(error);
      this.options.logger.warn("browser control request failed", {
        requestId: request?.id ?? requestId,
        operation: request?.operation,
        error: output,
      });
      if (requestId) {
        await this.complete(requestId, { ok: false, output }, signal).catch((completeError) => {
          this.options.logger.warn("browser control request failure result failed", {
            requestId,
            error: completeError,
          });
        });
      }
    }
  }

  private async executeRequest(request: ParsedBrowserHarnessRequest): Promise<BrowserHarnessResult> {
    const deadlineMs = Date.parse(request.deadlineAt);
    if (!Number.isFinite(deadlineMs) || deadlineMs <= Date.now()) {
      throw new Error("Browser control request expired before execution.");
    }
    const window = this.options.getWindow();
    if (!window || window.isDestroyed()) {
      throw new Error("No app window is available.");
    }
    const manager = browserSidebarManagerForWindow(window);
    switch (request.operation) {
      case "open":
        return manager.harnessOpen(request.input);
      case "snapshot":
        return manager.harnessSnapshot(request.input);
      case "moveCursor":
        return manager.harnessMoveCursor(request.input);
      case "click":
        return manager.harnessClick(request.input);
      case "typeText":
        return manager.harnessTypeText(request.input);
      case "pressKey":
        return manager.harnessKey(request.input);
      case "scroll":
        return manager.harnessScroll(request.input);
    }
  }

  private async register(signal: AbortSignal): Promise<void> {
    await this.fetchJson("/v1/desktop/browser-control/register", {
      method: "POST",
      signal,
      body: {
        executorToken: this.options.executorToken,
        instanceId: this.options.instanceId,
      },
    });
  }

  private async complete(requestId: string, result: BrowserHarnessResult, signal: AbortSignal): Promise<void> {
    await this.fetchJson(
      `/v1/desktop/browser-control/requests/${encodeURIComponent(requestId)}/result`,
      {
        method: "POST",
        signal,
        desktopExecutor: true,
        body: result,
      },
    );
  }

  private async fetchJson<T = unknown>(
    pathname: string,
    options: {
      method: "GET" | "POST";
      signal: AbortSignal;
      desktopExecutor?: boolean;
      body?: Record<string, unknown>;
    },
  ): Promise<T> {
    const response = await fetch(`${this.options.serverUrl}${pathname}`, {
      method: options.method,
      signal: options.signal,
      headers: {
        Authorization: `Bearer ${this.options.token}`,
        ...(options.desktopExecutor
          ? { "X-OpenPond-Desktop-Executor-Token": this.options.executorToken }
          : {}),
        ...(options.body ? { "Content-Type": "application/json" } : {}),
      },
      ...(options.body ? { body: JSON.stringify(options.body) } : {}),
    });
    if (!response.ok) {
      const body = await response.text().catch(() => "");
      throw new Error(`Browser control request failed with ${response.status}${body ? `: ${body}` : ""}`);
    }
    return await response.json() as T;
  }
}

function requestIdFromUnknown(value: unknown): string | null {
  const request = value as Partial<BrowserHarnessRequest> | null;
  return request && typeof request === "object" && typeof request.id === "string" && request.id.trim()
    ? request.id.trim()
    : null;
}

async function sleep(ms: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return;
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
