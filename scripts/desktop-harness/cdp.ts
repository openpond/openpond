import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import type { DesktopHarnessConnection, DesktopHarnessRenderer } from "./types.js";

type DevtoolsTarget = {
  type?: string;
  url?: string;
  title?: string;
  webSocketDebuggerUrl?: string;
};

type CdpResponse = {
  id?: number;
  result?: unknown;
  error?: { message?: string; data?: string };
};

type CdpEvaluation = {
  result?: {
    type?: string;
    value?: unknown;
    description?: string;
  };
  exceptionDetails?: {
    text?: string;
    exception?: { description?: string };
  };
};

export class CdpClient {
  private nextId = 1;
  private readonly pending = new Map<number, {
    resolve: (value: unknown) => void;
    reject: (error: Error) => void;
  }>();

  private constructor(private readonly socket: WebSocket) {
    socket.addEventListener("message", (event) => {
      const data = typeof event.data === "string" ? event.data : event.data.toString();
      const message = JSON.parse(data) as CdpResponse;
      if (!message.id) return;
      const pending = this.pending.get(message.id);
      if (!pending) return;
      this.pending.delete(message.id);
      if (message.error) pending.reject(new Error(message.error.message ?? "CDP command failed."));
      else pending.resolve(message.result);
    });
    socket.addEventListener("close", () => {
      for (const pending of this.pending.values()) pending.reject(new Error("CDP socket closed."));
      this.pending.clear();
    });
  }

  static async connect(url: string): Promise<CdpClient> {
    const socket = new WebSocket(url);
    await new Promise<void>((resolve, reject) => {
      socket.addEventListener("open", () => resolve(), { once: true });
      socket.addEventListener("error", () => reject(new Error("CDP socket failed to open.")), { once: true });
    });
    return new CdpClient(socket);
  }

  async send<T>(method: string, params: Record<string, unknown> = {}): Promise<T> {
    const id = this.nextId++;
    const result = new Promise<T>((resolve, reject) => {
      this.pending.set(id, {
        resolve: (value) => resolve(value as T),
        reject,
      });
    });
    this.socket.send(JSON.stringify({ id, method, params }));
    return result;
  }

  close(): void {
    this.socket.close();
  }
}

export class CdpDesktopHarnessRenderer implements DesktopHarnessRenderer {
  constructor(
    private readonly cdp: CdpClient | null,
    private readonly artifactsDir: string,
    private readonly defaultTimeoutMs: number,
  ) {}

  get connected(): boolean {
    return Boolean(this.cdp);
  }

  async evaluate<T>(expression: string): Promise<T> {
    const cdp = this.requireCdp();
    const result = await cdp.send<CdpEvaluation>("Runtime.evaluate", {
      expression,
      awaitPromise: true,
      returnByValue: true,
      userGesture: true,
    });
    if (result.exceptionDetails) {
      throw new Error(result.exceptionDetails.exception?.description ?? result.exceptionDetails.text ?? "Renderer evaluation failed.");
    }
    return result.result?.value as T;
  }

  async text(): Promise<string> {
    return this.evaluate<string>("document.body?.innerText || ''");
  }

  async assertText(text: string | RegExp, options: { timeoutMs?: number; label?: string } = {}): Promise<void> {
    const label = options.label ?? (typeof text === "string" ? text : text.source);
    await waitFor(async () => {
      const body = await this.text();
      return typeof text === "string" ? body.includes(text) : text.test(body);
    }, options.timeoutMs ?? this.defaultTimeoutMs, `Timed out waiting for renderer text: ${label}`);
  }

  async selectSession(sessionId: string, options: { timeoutMs?: number } = {}): Promise<void> {
    const selector = JSON.stringify(`[data-session-id="${sessionId}"]`);
    await waitFor(async () => {
      return this.evaluate<boolean>(
        `(() => {
          const row = document.querySelector(${selector});
          if (!row) return false;
          row.scrollIntoView({ block: "center" });
          if (!row.classList.contains("selected")) row.click();
          return row.classList.contains("selected");
        })()`,
      );
    }, options.timeoutMs ?? this.defaultTimeoutMs, `Timed out waiting for Desktop session row ${sessionId}.`);
  }

  async replaceComposerText(text: string): Promise<void> {
    const removedInvocation = await this.evaluate<boolean>(
      `(() => {
        const input = [...document.querySelectorAll('.composer-inline-input[role="textbox"]')]
          .find((candidate) => candidate instanceof HTMLElement && candidate.offsetParent !== null);
        const remove = input?.querySelector('.composer-invocation-remove');
        if (!(remove instanceof HTMLButtonElement)) return false;
        remove.click();
        return true;
      })()`,
    );
    if (removedInvocation) {
      await waitFor(
        async () => this.evaluate<boolean>(
          `(() => {
            const input = [...document.querySelectorAll('.composer-inline-input[role="textbox"]')]
              .find((candidate) => candidate instanceof HTMLElement && candidate.offsetParent !== null);
            return input instanceof HTMLElement && !input.querySelector('[data-inline-token="true"]');
          })()`,
        ),
        Math.min(this.defaultTimeoutMs, 10_000),
        "Desktop composer invocation did not clear.",
      );
    }
    const focused = await this.evaluate<boolean>(
      `(() => {
        const input = [...document.querySelectorAll('.composer-inline-input[role="textbox"]')]
          .find((candidate) => candidate instanceof HTMLElement && candidate.offsetParent !== null);
        if (!(input instanceof HTMLElement)) return false;
        input.focus();
        const selection = window.getSelection();
        const range = document.createRange();
        range.selectNodeContents(input);
        selection?.removeAllRanges();
        selection?.addRange(range);
        return true;
      })()`,
    );
    if (!focused) throw new Error("Desktop composer input was not available.");
    await this.requireCdp().send("Input.insertText", { text });
    const updated = await waitFor(
      async () => this.evaluate<boolean>(
        `(() => {
          const input = [...document.querySelectorAll('.composer-inline-input[role="textbox"]')]
            .find((candidate) => candidate instanceof HTMLElement && candidate.offsetParent !== null);
          return input instanceof HTMLElement && input.textContent === ${JSON.stringify(text)};
        })()`,
      ),
      Math.min(this.defaultTimeoutMs, 10_000),
      "Desktop composer did not retain inserted text.",
    );
    if (!updated) throw new Error("Desktop composer text was not updated.");
  }

  async submitComposer(prompt: string): Promise<void> {
    const focused = await this.evaluate<boolean>(
      `(() => {
        const inputs = [...document.querySelectorAll('.composer-inline-input[role="textbox"]')];
        const input = inputs.find((candidate) =>
          candidate instanceof HTMLElement &&
          candidate.offsetParent !== null &&
          candidate.querySelector('[data-inline-token="true"]'))
          ?? inputs.find((candidate) => candidate instanceof HTMLElement && candidate.offsetParent !== null)
          ?? inputs[0];
        if (!(input instanceof HTMLElement)) return false;
        for (const candidate of inputs) delete candidate.dataset.desktopHarnessComposerTarget;
        input.dataset.desktopHarnessComposerTarget = 'true';
        input.focus();
        const token = input.querySelector('[data-inline-token="true"]');
        input.dataset.desktopHarnessExpectedToken = token ? 'true' : 'false';
        for (const child of [...input.childNodes]) {
          if (child !== token) child.remove();
        }
        const selection = window.getSelection();
        const range = document.createRange();
        range.selectNodeContents(input);
        range.collapse(false);
        selection?.removeAllRanges();
        selection?.addRange(range);
        return true;
      })()`,
    );
    if (!focused) throw new Error("Desktop composer input was not available.");
    const pasted = await this.evaluate<boolean>(
      `(() => {
        const input = document.querySelector('[data-desktop-harness-composer-target="true"]');
        if (!(input instanceof HTMLElement)) return false;
        const clipboardData = new DataTransfer();
        clipboardData.setData('text/plain', ${JSON.stringify(prompt)});
        input.dispatchEvent(new ClipboardEvent('paste', {
          bubbles: true,
          cancelable: true,
          clipboardData,
        }));
        return true;
      })()`,
    );
    if (!pasted) throw new Error("Desktop composer prompt could not be pasted.");
    const readyToSubmit = await waitFor(async () => this.evaluate<boolean>(
      `(() => {
        const input = document.querySelector('[data-desktop-harness-composer-target="true"]');
        const form = input?.closest('form.composer');
        const send = form?.querySelector('.send-button');
        const expectedToken = input instanceof HTMLElement && input.dataset.desktopHarnessExpectedToken === 'true';
        return input instanceof HTMLElement &&
          (input.textContent ?? '').includes(${JSON.stringify(prompt)}) &&
          (!expectedToken || Boolean(input.querySelector('[data-inline-token="true"]'))) &&
          form instanceof HTMLFormElement &&
          send instanceof HTMLButtonElement &&
          !send.disabled;
      })()`,
    ), Math.min(this.defaultTimeoutMs, 10_000), "Desktop composer did not become ready to submit.");
    if (!readyToSubmit) throw new Error("Desktop composer did not retain the programmatically inserted prompt.");
    await this.evaluate(`new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)))`);
    const submitted = await this.evaluate<boolean>(
      `(() => {
        const input = document.querySelector('[data-desktop-harness-composer-target="true"]');
        const form = input?.closest('form.composer');
        const send = form?.querySelector('.send-button');
        if (!(form instanceof HTMLFormElement) || !(send instanceof HTMLButtonElement) || send.disabled) return false;
        form.requestSubmit(send);
        return true;
      })()`,
    );
    if (!submitted) throw new Error("Desktop composer form was not submitted.");
  }

  async setViewport(width: number, height: number): Promise<void> {
    await this.requireCdp().send("Emulation.setDeviceMetricsOverride", {
      width,
      height,
      deviceScaleFactor: 1,
      mobile: false,
      screenWidth: width,
      screenHeight: height,
    });
  }

  async screenshot(name: string): Promise<string> {
    const safeName = safeArtifactName(name);
    const outputPath = path.join(this.artifactsDir, `${safeName}.png`);
    await mkdir(path.dirname(outputPath), { recursive: true });
    const result = await this.requireCdp().send<{ data?: string }>("Page.captureScreenshot", {
      format: "png",
      captureBeyondViewport: true,
    });
    if (!result.data) throw new Error("Desktop screenshot did not return image data.");
    await writeFile(outputPath, Buffer.from(result.data, "base64"));
    return outputPath;
  }

  close(): void {
    this.cdp?.close();
  }

  private requireCdp(): CdpClient {
    if (!this.cdp) throw new Error("Desktop renderer is not connected. Use --isolated or attach with --devtools-port.");
    return this.cdp;
  }
}

export async function waitForDevtoolsTarget(
  port: number,
  timeoutMs: number,
  predicate: (candidate: Required<DevtoolsTarget>) => boolean,
): Promise<Required<DevtoolsTarget>> {
  return waitFor(async () => {
    const targets = await fetch(`http://127.0.0.1:${port}/json/list`)
      .then((response) => (response.ok ? response.json() : null))
      .catch(() => null);
    if (!Array.isArray(targets)) return null;
    return targets.find((target) => isUsableTarget(target) && predicate(target)) ?? null;
  }, timeoutMs, `Timed out waiting for Electron DevTools target on port ${port}.`);
}

export async function waitForRendererBridge(cdp: CdpClient, timeoutMs: number): Promise<void> {
  await waitFor(async () =>
    evaluateValue<boolean>(
      cdp,
      `document.readyState !== "loading" &&
        typeof window.openpond === "object" &&
        typeof window.openpond.getConnection === "function"`,
    ), timeoutMs, "Timed out waiting for Desktop preload bridge.");
}

export async function rendererConnection(cdp: CdpClient): Promise<DesktopHarnessConnection> {
  return evaluateValue<DesktopHarnessConnection>(
    cdp,
    `window.openpond.getConnection().then((connection) => ({
      serverUrl: connection.serverUrl,
      token: connection.token
    }))`,
  );
}

export async function waitFor<T>(
  probe: () => Promise<T | null | false> | T | null | false,
  timeoutMs: number,
  message: string,
): Promise<T> {
  const started = Date.now();
  let lastError: unknown;
  while (Date.now() - started < timeoutMs) {
    try {
      const value = await probe();
      if (value) return value;
    } catch (error) {
      lastError = error;
    }
    await delay(250);
  }
  throw new Error(lastError ? `${message} Last error: ${String(lastError)}` : message);
}

export async function evaluateValue<T>(cdp: CdpClient, expression: string): Promise<T> {
  const renderer = new CdpDesktopHarnessRenderer(cdp, process.cwd(), 1);
  return renderer.evaluate<T>(expression);
}

export function safeArtifactName(value: string): string {
  return value.trim().toLowerCase().replace(/[^a-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "") || "artifact";
}

export function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isUsableTarget(target: DevtoolsTarget): target is Required<DevtoolsTarget> {
  return (
    target.type === "page" &&
    typeof target.webSocketDebuggerUrl === "string" &&
    typeof target.url === "string" &&
    target.url !== "about:blank" &&
    !target.url.startsWith("devtools://")
  );
}
