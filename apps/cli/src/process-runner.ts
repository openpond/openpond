import { Buffer } from "node:buffer";
import { spawn } from "node:child_process";

export type ProcessCommandResult = {
  code: number | null;
  signal: NodeJS.Signals | null;
  terminationReason: "exit" | "output" | "signal" | "timeout";
  stdout: string;
  stderr: string;
  timedOut: boolean;
  stdoutTruncated: boolean;
  stderrTruncated: boolean;
};

export type ProcessCommandOptions = {
  cwd?: string;
  detached?: boolean;
  env?: NodeJS.ProcessEnv | Record<string, string | undefined>;
  inherit?: boolean;
  shell?: boolean;
  stdin?: string | Buffer | Uint8Array;
  timeoutMs?: number;
  maxOutputBytes?: number;
  terminateWhenStdoutIncludes?: string;
};

export const DEFAULT_PROCESS_TIMEOUT_MS = 10 * 60 * 1000;
export const DEFAULT_PROCESS_MAX_OUTPUT_BYTES = 2 * 1024 * 1024;

export function runProcessCommand(
  command: string,
  args: string[] = [],
  options: ProcessCommandOptions = {}
): Promise<ProcessCommandResult> {
  if (options.inherit && options.terminateWhenStdoutIncludes !== undefined) {
    return Promise.reject(new Error("terminateWhenStdoutIncludes requires captured stdout"));
  }
  if (options.terminateWhenStdoutIncludes === "") {
    return Promise.reject(new Error("terminateWhenStdoutIncludes must not be empty"));
  }
  return new Promise((resolve, reject) => {
    const proc = spawn(command, args, {
      cwd: options.cwd,
      env: options.env ? { ...process.env, ...options.env } : undefined,
      shell: options.shell,
      detached: options.detached ?? process.platform !== "win32",
      stdio: options.inherit
        ? "inherit"
        : [options.stdin === undefined ? "ignore" : "pipe", "pipe", "pipe"],
    });
    const stdout = new BoundedOutput(maxOutputBytes(options));
    const stderr = new BoundedOutput(maxOutputBytes(options));
    let timedOut = false;
    const timeoutMs = options.timeoutMs ?? DEFAULT_PROCESS_TIMEOUT_MS;
    let timeout: ReturnType<typeof setTimeout> | undefined;
    let forceKill: ReturnType<typeof setTimeout> | undefined;
    let requestedTermination: "output" | "timeout" | null = null;
    let settled = false;

    const clearTimers = () => {
      if (timeout) clearTimeout(timeout);
      if (forceKill) clearTimeout(forceKill);
    };

    const requestTermination = (reason: "output" | "timeout") => {
      if (requestedTermination !== null || settled) return;
      requestedTermination = reason;
      timedOut = reason === "timeout";
      if (timeout) {
        clearTimeout(timeout);
        timeout = undefined;
      }
      terminateProcessTree(proc.pid, "SIGTERM");
      forceKill = setTimeout(() => {
        if (proc.exitCode === null && proc.signalCode === null) terminateProcessTree(proc.pid, "SIGKILL");
      }, 5000);
    };

    if (timeoutMs > 0) {
      timeout = setTimeout(() => {
        requestTermination("timeout");
      }, timeoutMs);
    }

    if (!options.inherit) {
      proc.stdout?.on("data", (chunk) => {
        stdout.append(chunk);
        const marker = options.terminateWhenStdoutIncludes;
        if (marker !== undefined && stdout.text().includes(marker)) {
          requestTermination("output");
        }
      });
      proc.stderr?.on("data", (chunk) => {
        stderr.append(chunk);
      });
    }

    proc.on("error", (error) => {
      clearTimers();
      settled = true;
      reject(error);
    });
    proc.on("close", (code, signal) => {
      if (settled) return;
      settled = true;
      clearTimers();
      resolve({
        code,
        signal,
        terminationReason: requestedTermination ?? (signal ? "signal" : "exit"),
        stdout: stdout.text(),
        stderr: stderr.text(),
        timedOut,
        stdoutTruncated: stdout.truncated,
        stderrTruncated: stderr.truncated,
      });
    });

    if (options.stdin !== undefined) {
      proc.stdin?.end(options.stdin);
    }
  });
}

class BoundedOutput {
  readonly #chunks: Buffer[] = [];
  readonly #maxBytes: number;
  #bytes = 0;
  truncated = false;

  constructor(maxBytes: number) {
    this.#maxBytes = maxBytes;
  }

  append(value: string | Buffer | Uint8Array): void {
    const chunk = Buffer.isBuffer(value) ? value : Buffer.from(value);
    const remaining = this.#maxBytes - this.#bytes;
    if (remaining <= 0) {
      if (chunk.byteLength > 0) this.truncated = true;
      return;
    }
    if (chunk.byteLength <= remaining) {
      this.#chunks.push(chunk);
      this.#bytes += chunk.byteLength;
      return;
    }
    this.#chunks.push(chunk.subarray(0, remaining));
    this.#bytes += remaining;
    this.truncated = true;
  }

  text(): string {
    const value = Buffer.concat(this.#chunks, this.#bytes).toString("utf8");
    return this.truncated ? `${value}\n[truncated after ${this.#maxBytes} bytes]\n` : value;
  }
}

function maxOutputBytes(options: ProcessCommandOptions): number {
  const value = options.maxOutputBytes ?? DEFAULT_PROCESS_MAX_OUTPUT_BYTES;
  return Math.max(0, Math.floor(value));
}

function terminateProcessTree(pid: number | undefined, signal: "SIGTERM" | "SIGKILL"): void {
  if (!pid) return;
  if (process.platform === "win32") {
    const args = ["/PID", String(pid), "/T"];
    if (signal === "SIGKILL") args.push("/F");
    const killer = spawn("taskkill", args, { stdio: "ignore", windowsHide: true });
    killer.unref();
    return;
  }
  try {
    process.kill(-pid, signal);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
  }
}
