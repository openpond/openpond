import { spawn } from "node:child_process";

export type CommandProbeResult = {
  state: "success" | "missing" | "timeout" | "error" | "truncated";
  stdout: string;
  stderr: string;
  exitCode: number | null;
};

export type CommandProbe = (
  executable: string,
  args: readonly string[],
  options?: { timeoutMs?: number; maxOutputBytes?: number },
) => Promise<CommandProbeResult>;

export const runCommandProbe: CommandProbe = async (executable, args, options = {}) => {
  const timeoutMs = options.timeoutMs ?? 10_000;
  const maxOutputBytes = options.maxOutputBytes ?? 1_000_000;
  return new Promise((resolve) => {
    let settled = false;
    let stdout: Buffer<ArrayBufferLike> = Buffer.alloc(0);
    let stderr: Buffer<ArrayBufferLike> = Buffer.alloc(0);
    const child = spawn(executable, [...args], {
      shell: false,
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    const finish = (result: CommandProbeResult) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      resolve(result);
    };
    const timeout = setTimeout(() => {
      child.kill("SIGKILL");
      finish({ state: "timeout", stdout: stdout.toString("utf8"), stderr: stderr.toString("utf8"), exitCode: null });
    }, timeoutMs);
    timeout.unref?.();
    const append = (current: Buffer<ArrayBufferLike>, chunk: Buffer<ArrayBufferLike>): Buffer<ArrayBufferLike> => Buffer.concat([current, chunk], Math.min(maxOutputBytes + 1, current.length + chunk.length));
    const capture = (kind: "stdout" | "stderr", chunk: Buffer) => {
      if (kind === "stdout") stdout = append(stdout, chunk);
      else stderr = append(stderr, chunk);
      if (stdout.length + stderr.length <= maxOutputBytes) return;
      child.kill("SIGKILL");
      finish({
        state: "truncated",
        stdout: stdout.subarray(0, maxOutputBytes).toString("utf8"),
        stderr: stderr.subarray(0, Math.max(0, maxOutputBytes - stdout.length)).toString("utf8"),
        exitCode: null,
      });
    };
    child.stdout.on("data", (chunk: Buffer) => capture("stdout", chunk));
    child.stderr.on("data", (chunk: Buffer) => capture("stderr", chunk));
    child.once("error", (error: NodeJS.ErrnoException) => finish({
      state: error.code === "ENOENT" ? "missing" : "error",
      stdout: stdout.toString("utf8"),
      stderr: error.message,
      exitCode: null,
    }));
    child.once("exit", (exitCode) => finish({
      state: exitCode === 0 ? "success" : "error",
      stdout: stdout.toString("utf8"),
      stderr: stderr.toString("utf8"),
      exitCode,
    }));
  });
};
