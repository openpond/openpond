import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import type { Readable } from "node:stream";
import { PYTHON_SANDBOX_WORKER_SOURCE } from "./python-sandbox-worker.js";
import { PythonSandboxUnavailableError, pythonSandboxLaunch } from "./python-sandbox-runtime.js";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";

const DEFAULT_MAX_MEMORY_BYTES = 256 * 1024 * 1024;
const DEFAULT_MEMORY_POLL_INTERVAL_MS = 100;
const MAX_STDERR_BYTES = 4_096;

export type PythonSandboxResult = {
  ok: boolean;
  stdout: string;
  result: unknown;
  error: string | null;
};

export type PersistentPythonSandboxOptions = {
  timeoutMs?: number;
  maxOutputBytes?: number;
  maxMemoryBytes?: number;
  memoryPollIntervalMs?: number;
  memoryUsage?: (pid: number) => Promise<number | null>;
  pythonBin?: string;
  /** Trusted runtime configuration; never supplied by a model tool call. */
  bwrapPath?: string;
};

export class PersistentPythonSandbox {
  private readonly child: ChildProcessWithoutNullStreams;
  private readonly pending = new Map<string, { resolve: (value: PythonSandboxResult) => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout> }>();
  private readonly maxMemoryBytes: number;
  private readonly memoryPollIntervalMs: number;
  private readonly memoryUsage: (pid: number) => Promise<number | null>;
  private memoryTimer: ReturnType<typeof setInterval> | null = null;
  private memoryProbeInFlight = false;
  private terminationError: Error | null = null;
  private stderr = "";
  private closed = false;
  private exited = false;
  private started = false;
  private sandboxPid: number | null = null;
  private response = "";
  private readonly ready: Promise<void>;
  private resolveReady!: () => void;
  private rejectReady!: (error: Error) => void;
  private readonly startupTimer: ReturnType<typeof setTimeout>;

  constructor(private readonly options: PersistentPythonSandboxOptions = {}) {
    this.maxMemoryBytes = Math.max(1, Math.trunc(options.maxMemoryBytes ?? DEFAULT_MAX_MEMORY_BYTES));
    this.memoryPollIntervalMs = Math.max(10, Math.trunc(options.memoryPollIntervalMs ?? DEFAULT_MEMORY_POLL_INTERVAL_MS));
    this.memoryUsage = options.memoryUsage ?? readResidentMemoryBytes;
    const launch = pythonSandboxLaunch({
      pythonBin: options.pythonBin,
      maxMemoryBytes: this.maxMemoryBytes,
      maxOutputBytes: options.maxOutputBytes ?? 16_384,
      source: PYTHON_SANDBOX_WORKER_SOURCE,
    });
    this.ready = new Promise<void>((resolve, reject) => { this.resolveReady = resolve; this.rejectReady = reject; });
    // Startup may fail before the caller asks to run code.
    void this.ready.catch(() => undefined);
    this.child = spawn(options.bwrapPath ?? "/usr/bin/bwrap", launch, {
      cwd: "/", env: {}, stdio: ["pipe", "pipe", "pipe", "pipe"],
    }) as ChildProcessWithoutNullStreams;
    this.startupTimer = setTimeout(() => this.terminate(new PythonSandboxUnavailableError("Isolated Python startup timed out.")), 5_000);
    this.startupTimer.unref?.();
    let info = "";
    const infoStream = this.child.stdio[3] as Readable | null;
    infoStream?.on("data", (chunk: Buffer) => {
      info += chunk.toString("utf8");
      if (info.length > 4_096) this.terminate(new PythonSandboxUnavailableError("Invalid sandbox process identity."));
    });
    infoStream?.once("end", () => {
      try {
        const pid: unknown = JSON.parse(info)["child-pid"];
        if (typeof pid !== "number" || !Number.isSafeInteger(pid) || pid <= 0) throw new Error();
        this.sandboxPid = pid;
      } catch { this.terminate(new PythonSandboxUnavailableError("Sandbox process identity is unavailable.")); }
    });
    this.child.stdout.setEncoding("utf8");
    this.child.stdout.on("data", (chunk: string) => this.handleOutput(chunk));
    this.child.stderr.setEncoding("utf8");
    this.child.stderr.on("data", (chunk: string) => {
      this.stderr = `${this.stderr}${chunk}`.slice(-MAX_STDERR_BYTES);
    });
    this.child.stdin.on("error", () => this.terminate(this.processError("Python sandbox input closed.")));
    this.child.once("error", (error) => this.terminate(new PythonSandboxUnavailableError(error.message)));
    this.child.once("close", (code, signal) => {
      this.exited = true;
      clearTimeout(this.startupTimer);
      this.stopMemoryMonitor();
      if (!this.closed) {
        const detail = this.stderr.trim();
        this.terminate(this.processError(`Isolated Python exited with ${code ?? signal}${detail ? `: ${detail}` : "."}`));
      }
    });
  }

  async run(code: string, signal?: AbortSignal): Promise<PythonSandboxResult> {
    if (this.terminationError) throw this.terminationError;
    if (this.closed) throw new Error("Python sandbox is closed.");
    if (Buffer.byteLength(code, "utf8") > 10_000) throw new Error("Python code exceeds the 10,000-byte limit.");
    if (signal?.aborted) throw abortError(signal);
    await this.ready;
    if (this.terminationError) throw this.terminationError;
    if (this.closed) throw new Error("Python sandbox is closed.");
    if (signal?.aborted) throw abortError(signal);
    const id = `python_${randomUUID()}`;
    const result = new Promise<PythonSandboxResult>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        if (this.pending.size === 0) this.stopMemoryMonitor();
        reject(new Error("Python sandbox execution timed out."));
        void this.close();
      }, this.options.timeoutMs ?? 1_500);
      timer.unref?.();
      this.pending.set(id, { resolve, reject, timer });
    });
    const abort = () => {
      const pending = this.pending.get(id);
      if (!pending) return;
      clearTimeout(pending.timer);
      this.pending.delete(id);
      if (this.pending.size === 0) this.stopMemoryMonitor();
      pending.reject(abortError(signal));
      void this.close();
    };
    signal?.addEventListener("abort", abort, { once: true });
    this.startMemoryMonitor();
    this.child.stdin.write(`${JSON.stringify({ id, code })}\n`);
    try {
      return await result;
    } finally {
      signal?.removeEventListener("abort", abort);
    }
  }

  async close(): Promise<void> {
    this.closed = true;
    clearTimeout(this.startupTimer);
    this.rejectReady(new PythonSandboxUnavailableError("Python sandbox closed during startup."));
    this.failAll(new Error("Python sandbox closed."));
    if (this.exited) return;
    const exited = new Promise<void>((resolve) => this.child.once("close", () => resolve()));
    this.killProcesses();
    await exited;
  }

  private terminate(error: Error): void {
    this.terminationError ??= error;
    clearTimeout(this.startupTimer);
    this.rejectReady(this.terminationError);
    this.failAll(this.terminationError);
    this.killProcesses();
  }

  private killProcesses(): void {
    if (this.exited) return;
    // Kill namespace PID 1 directly using bwrap's host-side identity. Model
    // code can clear its parent-death signal or change process groups; neither
    // must let it outlive the attempt. Kernel PID-namespace teardown kills its
    // descendants when PID 1 dies.
    if (this.sandboxPid) {
      try { process.kill(this.sandboxPid, "SIGKILL"); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error; }
    }
    this.child.kill("SIGKILL");
  }

  private processError(detail: string): Error {
    // A model that crashes its own interpreter must not turn a policy failure
    // into an unavailable-runtime exemption from reward accounting.
    return this.started ? new Error(detail) : new PythonSandboxUnavailableError(detail);
  }

  private handleOutput(chunk: string): void {
    this.response += chunk;
    // Bound the protocol frame before parsing, including output that bypasses
    // redirect_stdout. JSON escaping can expand the allowed output sixfold.
    const limit = (this.options.maxOutputBytes ?? 16_384) * 6 + 4_096;
    const lines = this.response.split("\n");
    this.response = lines.pop()!;
    for (const line of [...lines, this.response]) {
      if (Buffer.byteLength(line) > limit) {
        this.terminate(new Error("Python sandbox output exceeded the byte limit."));
        return;
      }
    }
    for (const line of lines) this.handleLine(line);
  }

  private handleLine(line: string): void {
    let value: Record<string, unknown>;
    try {
      value = JSON.parse(line) as Record<string, unknown>;
    } catch {
      return;
    }
    if (!value || typeof value !== "object") return;
    if (value.ready === true && !this.terminationError) {
      this.started = true;
      clearTimeout(this.startupTimer);
      this.resolveReady();
      return;
    }
    const id = typeof value.id === "string" ? value.id : "";
    const pending = this.pending.get(id);
    if (!pending) return;
    clearTimeout(pending.timer);
    this.pending.delete(id);
    if (this.pending.size === 0) this.stopMemoryMonitor();
    const stdout = typeof value.stdout === "string" ? value.stdout : "";
    const serialized = JSON.stringify(value.result ?? null);
    if (Buffer.byteLength(stdout + serialized, "utf8") > (this.options.maxOutputBytes ?? 16_384)) {
      pending.resolve({ ok: false, stdout: "", result: null, error: "Python sandbox output exceeded the byte limit." });
      return;
    }
    pending.resolve(value.ok === true
      ? { ok: true, stdout, result: value.result ?? null, error: null }
      : { ok: false, stdout: "", result: null, error: typeof value.error === "string" ? value.error : "Python execution failed." });
  }

  private failAll(error: Error): void {
    this.stopMemoryMonitor();
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.pending.clear();
  }

  private startMemoryMonitor(): void {
    if (this.memoryTimer || !this.child.pid) return;
    void this.probeMemory();
    this.memoryTimer = setInterval(() => void this.probeMemory(), this.memoryPollIntervalMs);
    this.memoryTimer.unref?.();
  }

  private stopMemoryMonitor(): void {
    if (this.memoryTimer) clearInterval(this.memoryTimer);
    this.memoryTimer = null;
  }

  private async probeMemory(): Promise<void> {
    const pid = this.sandboxPid;
    if (!pid || this.memoryProbeInFlight || this.terminationError || this.pending.size === 0) return;
    this.memoryProbeInFlight = true;
    try {
      const residentBytes = await this.memoryUsage(pid);
      if (residentBytes !== null && residentBytes > this.maxMemoryBytes && !this.terminationError) {
        this.terminate(new Error(`Python sandbox exceeded the ${this.maxMemoryBytes}-byte memory limit.`));
      }
    } catch {
      this.terminate(new Error("Python sandbox memory monitoring failed."));
    } finally {
      this.memoryProbeInFlight = false;
    }
  }
}

export async function readResidentMemoryBytes(pid: number): Promise<number | null> {
  if (!Number.isInteger(pid) || pid <= 0) return null;
  try {
    const status = await readFile(`/proc/${pid}/status`, "utf8");
    const kibibytes = /^VmRSS:\s+(\d+)\s+kB$/m.exec(status)?.[1];
    return kibibytes === undefined ? null : Number(kibibytes) * 1024;
  } catch {
    return null;
  }
}

function abortError(signal: AbortSignal | undefined): Error {
  if (signal?.reason instanceof Error && signal.reason.name === "AbortError") return signal.reason;
  const error = new Error("Python sandbox execution was cancelled.", { cause: signal?.reason });
  error.name = "AbortError";
  return error;
}
