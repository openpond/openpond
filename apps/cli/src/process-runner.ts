import { Buffer } from "node:buffer";
import { spawn } from "node:child_process";

export type ProcessCommandResult = {
  code: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  stdoutTruncated: boolean;
  stderrTruncated: boolean;
};

export type ProcessCommandOptions = {
  cwd?: string;
  env?: NodeJS.ProcessEnv | Record<string, string | undefined>;
  inherit?: boolean;
  shell?: boolean;
  stdin?: string | Buffer | Uint8Array;
  timeoutMs?: number;
  maxOutputBytes?: number;
};

export const DEFAULT_PROCESS_TIMEOUT_MS = 10 * 60 * 1000;
export const DEFAULT_PROCESS_MAX_OUTPUT_BYTES = 2 * 1024 * 1024;

export function runProcessCommand(
  command: string,
  args: string[] = [],
  options: ProcessCommandOptions = {}
): Promise<ProcessCommandResult> {
  return new Promise((resolve, reject) => {
    const proc = spawn(command, args, {
      cwd: options.cwd,
      env: options.env ? { ...process.env, ...options.env } : undefined,
      shell: options.shell,
      stdio: options.inherit
        ? "inherit"
        : [options.stdin === undefined ? "ignore" : "pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    let stdoutTruncated = false;
    let stderrTruncated = false;
    const timeoutMs = options.timeoutMs ?? DEFAULT_PROCESS_TIMEOUT_MS;
    const maxOutputBytes =
      options.maxOutputBytes ?? DEFAULT_PROCESS_MAX_OUTPUT_BYTES;
    let timeout: ReturnType<typeof setTimeout> | undefined;
    let forceKill: ReturnType<typeof setTimeout> | undefined;

    const clearTimers = () => {
      if (timeout) clearTimeout(timeout);
      if (forceKill) clearTimeout(forceKill);
    };

    if (timeoutMs > 0) {
      timeout = setTimeout(() => {
        timedOut = true;
        proc.kill("SIGTERM");
      }, timeoutMs);
      forceKill = setTimeout(() => {
        if (timedOut && proc.exitCode === null) proc.kill("SIGKILL");
      }, timeoutMs + 5000);
    }

    if (!options.inherit) {
      proc.stdout?.on("data", (chunk) => {
        const next = appendBoundedOutput(
          stdout,
          String(chunk),
          maxOutputBytes,
          stdoutTruncated
        );
        stdout = next.text;
        stdoutTruncated = next.truncated;
      });
      proc.stderr?.on("data", (chunk) => {
        const next = appendBoundedOutput(
          stderr,
          String(chunk),
          maxOutputBytes,
          stderrTruncated
        );
        stderr = next.text;
        stderrTruncated = next.truncated;
      });
    }

    proc.on("error", (error) => {
      clearTimers();
      reject(error);
    });
    proc.on("close", (code) => {
      clearTimers();
      resolve({
        code,
        stdout,
        stderr,
        timedOut,
        stdoutTruncated,
        stderrTruncated,
      });
    });

    if (options.stdin !== undefined) {
      proc.stdin?.end(options.stdin);
    }
  });
}

function appendBoundedOutput(
  current: string,
  chunk: string,
  maxBytes: number,
  alreadyTruncated: boolean
): { text: string; truncated: boolean } {
  if (alreadyTruncated) return { text: current, truncated: true };
  const combined = `${current}${chunk}`;
  if (Buffer.byteLength(combined, "utf8") <= maxBytes) {
    return { text: combined, truncated: false };
  }
  const text = `${Buffer.from(combined)
    .subarray(0, Math.max(0, maxBytes))
    .toString("utf8")}\n[truncated after ${maxBytes} bytes]\n`;
  return { text, truncated: true };
}
