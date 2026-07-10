import { spawn, type ChildProcess } from "node:child_process";

export type DesktopBackendOwnership = "none" | "owned" | "reused";

export class DesktopBackendManager {
  #server: ChildProcess | null = null;
  #renderer: ChildProcess | null = null;
  #serverOwnership: DesktopBackendOwnership = "none";
  #closePromise: Promise<void> | null = null;

  useOwnedServer(child: ChildProcess): void {
    this.#assertOpen();
    this.#server = child;
    this.#serverOwnership = "owned";
  }

  useReusedServer(): void {
    this.#assertOpen();
    this.#server = null;
    this.#serverOwnership = "reused";
  }

  useOwnedRenderer(child: ChildProcess): void {
    this.#assertOpen();
    this.#renderer = child;
  }

  releaseServer(child: ChildProcess): void {
    if (this.#server !== child) return;
    this.#server = null;
    this.#serverOwnership = "none";
  }

  releaseRenderer(child: ChildProcess): void {
    if (this.#renderer === child) this.#renderer = null;
  }

  async stopServer(): Promise<void> {
    const child = this.#serverOwnership === "owned" ? this.#server : null;
    this.#server = null;
    this.#serverOwnership = "none";
    if (child) await stopOwnedProcessTree(child);
  }

  close(): Promise<void> {
    if (this.#closePromise) return this.#closePromise;
    const server = this.#serverOwnership === "owned" ? this.#server : null;
    const renderer = this.#renderer;
    this.#server = null;
    this.#renderer = null;
    this.#serverOwnership = "none";
    this.#closePromise = Promise.all(
      [server, renderer].flatMap((child) => child ? [stopOwnedProcessTree(child)] : []),
    ).then(() => undefined);
    return this.#closePromise;
  }

  status(): { server: DesktopBackendOwnership; renderer: "none" | "owned" } {
    return { server: this.#serverOwnership, renderer: this.#renderer ? "owned" : "none" };
  }

  #assertOpen(): void {
    if (this.#closePromise) throw new Error("Desktop backend manager is closed.");
  }
}

export async function stopOwnedProcessTree(
  child: ChildProcess,
  options: { gracefulTimeoutMs?: number; killTimeoutMs?: number } = {},
): Promise<void> {
  signalProcessTree(child, "SIGTERM");
  if (await waitForExit(child, options.gracefulTimeoutMs ?? 5_000)) return;
  signalProcessTree(child, "SIGKILL");
  if (!(await waitForExit(child, options.killTimeoutMs ?? 2_000))) {
    throw new Error(`Desktop-owned process tree ${child.pid ?? "unknown"} did not exit.`);
  }
}

function signalProcessTree(child: ChildProcess, signal: NodeJS.Signals): void {
  if (!child.pid || child.exitCode !== null || child.signalCode !== null) return;
  if (process.platform === "win32") {
    spawn(
      "taskkill",
      ["/pid", String(child.pid), "/t", ...(signal === "SIGKILL" ? ["/f"] : [])],
      { stdio: "ignore", windowsHide: true },
    ).unref();
    return;
  }
  try {
    process.kill(-child.pid, signal);
  } catch {
    child.kill(signal);
  }
}

function waitForExit(child: ChildProcess, timeoutMs: number): Promise<boolean> {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve(true);
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      child.off("exit", onExit);
      resolve(false);
    }, timeoutMs);
    const onExit = () => {
      clearTimeout(timer);
      resolve(true);
    };
    child.once("exit", onExit);
  });
}
