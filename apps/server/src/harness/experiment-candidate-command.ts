import { spawn } from "node:child_process";
import { realpath } from "node:fs/promises";
import path from "node:path";

export type CandidateCommandAuthority = {
  candidateId: string; candidateRevision: number; ownerId: string; sessionId: string; turnId: string;
  sourceRoot: string;
  /** Trusted server-owned Work adapter only; never accepted from model commands. */
  layout?: "work" | "profile_case";
  /** Explicit selected component paths; the rest of the candidate is mounted read-only. */
  writablePaths: readonly string[];
  protectedPaths?: readonly string[];
  /** Server-owned public runtime bundles, never user-selected mounts or a live Profile directory. */
  runtimeMounts?: readonly { source: string; destination: string }[];
};
export type CandidateCommandReceipt = { code: number | null; stdout: string; stderr: string; timedOut: boolean; stdoutTruncated: boolean; stderrTruncated: boolean };

/** Real Linux filesystem/PID/network isolation. No live repository or host home is mounted.
 * Every invocation obtains fresh durable authority; caller/model paths cannot select the mount.
 */
export function createCandidateCommandExecutor(deps: {
  authorize(input: { candidateId: string; sessionId: string; turnId: string; expectedRevision: number }): Promise<CandidateCommandAuthority>;
  bwrapPath?: string;
}) {
  return async function execute(input: { candidateId: string; sessionId: string; turnId: string; expectedRevision: number;
    command: string; stdin?: string; cwd?: string; timeoutMs?: number; maxOutputBytes?: number; signal?: AbortSignal }): Promise<CandidateCommandReceipt> {
    if (!input.command.trim() || input.command.length > 20_000) throw new Error("Candidate command is empty or exceeds its bounded size.");
    if(input.stdin!==undefined&&Buffer.byteLength(input.stdin)>1_000_000)throw new Error("Candidate command input exceeds its bounded size.");
    input.signal?.throwIfAborted();
    const authority = await deps.authorize(input);
    if (authority.candidateId !== input.candidateId || authority.sessionId !== input.sessionId || authority.turnId !== input.turnId || authority.candidateRevision !== input.expectedRevision || !authority.ownerId)
      throw new Error("Candidate command admission differs from its durable owner/session/turn/revision.");
    const sourceRoot = await realpath(authority.sourceRoot), cwd = input.cwd ? await realpath(input.cwd) : sourceRoot;
    const relative = path.relative(sourceRoot, cwd);
    if (relative.startsWith("..") || path.isAbsolute(relative)) throw new Error("Candidate command cwd escapes its isolated source.");
    const timeoutMs = Math.min(Math.max(input.timeoutMs ?? 120_000, 1), 180_000), maxOutputBytes = Math.min(Math.max(input.maxOutputBytes ?? 250_000, 1), 1_000_000);
    const mountRoot=authority.layout==="work"?"/workspace":"/workspace/work";
    const args = ["--unshare-all", "--die-with-parent", "--new-session", "--clearenv", "--ro-bind", "/usr", "/usr", "--ro-bind", "/lib", "/lib", "--ro-bind", "/lib64", "/lib64",
      "--symlink", "usr/bin", "/bin", "--symlink", "usr/sbin", "/sbin", "--proc", "/proc", "--dev", "/dev", "--tmpfs", "/tmp", "--dir", "/tmp/home", "--dir", "/runtime", "--dir", "/workspace",
      "--ro-bind", sourceRoot, mountRoot, "--ro-bind", process.execPath, "/runtime/node", "--setenv", "HOME", "/tmp/home", "--setenv", "PATH", "/runtime:/usr/bin:/bin",
      "--setenv", "TMPDIR", "/tmp", "--setenv", "LANG", "C.UTF-8", "--chdir", `${mountRoot}${relative ? `/${relative.split(path.sep).join("/")}` : authority.layout==="work"?"/work":""}`];
    for (const [paths, binding] of [[authority.writablePaths, "--bind"], [authority.protectedPaths ?? [], "--ro-bind"]] as const) for (const selected of paths) {
      if (path.isAbsolute(selected) || selected.split(/[\\/]/).includes("..")) throw new Error("Candidate mount path escapes its admitted source.");
      const target = await realpath(path.resolve(sourceRoot, selected)), within = path.relative(sourceRoot, target);
      if (within.startsWith("..") || path.isAbsolute(within)) throw new Error("Candidate mount symlink escapes its admitted source.");
      args.push(binding, target, `${mountRoot}${within ? `/${within.split(path.sep).join("/")}` : ""}`);
    }
    if (authority.layout === "profile_case")
      args.push("--symlink", "work/inputs", "/workspace/inputs", "--symlink", "work/outputs", "/workspace/outputs");
    for (const mount of authority.runtimeMounts ?? []) {
      const destination = path.posix.normalize(mount.destination), source = await realpath(mount.source);
      if ((!destination.startsWith("/runtime/") && destination!=="/workspace/node_modules") || destination === "/runtime/node" || destination.includes("\0") || source === sourceRoot || source.startsWith(`${sourceRoot}${path.sep}`))
        throw new Error("Candidate runtime mount must be a separate server-owned public runtime bundle.");
      args.push("--ro-bind", source, destination);
    }
    args.push("--", "/bin/sh", "-lc", input.command);
    return new Promise<CandidateCommandReceipt>((resolve, reject) => {
      const child = spawn(deps.bwrapPath ?? "/usr/bin/bwrap", args, { detached: true, stdio: [input.stdin===undefined?"ignore":"pipe", "pipe", "pipe"], env: { PATH: "/usr/bin:/bin" } });
      if(input.stdin!==undefined&&child.stdin){child.stdin.on("error",()=>undefined);child.stdin.end(input.stdin);}
      const buffers = { stdout: [] as Buffer[], stderr: [] as Buffer[] }, sizes = { stdout: 0, stderr: 0 }, truncated = { stdout: false, stderr: false };
      let timedOut = false;
      const kill = () => { try { if (child.pid) process.kill(-child.pid, "SIGKILL"); } catch { child.kill("SIGKILL"); } };
      const abort = () => kill();
      const timeout = setTimeout(() => { timedOut = true; kill(); }, timeoutMs);
      input.signal?.addEventListener("abort", abort, { once: true });
      for (const name of ["stdout", "stderr"] as const) child[name]!.on("data", (value: Buffer) => {
        const remaining = Math.max(0, maxOutputBytes - sizes[name]); if (remaining) buffers[name].push(value.subarray(0, remaining));
        sizes[name] += value.byteLength; if (sizes[name] > maxOutputBytes) truncated[name] = true;
      });
      const clean = () => { clearTimeout(timeout); input.signal?.removeEventListener("abort", abort); };
      child.once("error", failure => { clean(); reject(new Error(`Candidate filesystem confinement is unavailable: ${failure.message}`)); });
      child.once("close", code => { clean(); if (input.signal?.aborted) reject(input.signal.reason); else resolve({ code, stdout: Buffer.concat(buffers.stdout).toString("utf8"), stderr: Buffer.concat(buffers.stderr).toString("utf8"), timedOut,
        stdoutTruncated: truncated.stdout, stderrTruncated: truncated.stderr }); });
      if (input.signal?.aborted) kill();
    });
  };
}
