import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { cp, mkdir, stat } from "node:fs/promises";
import path from "node:path";

export type PackagedProcessSnapshot = {
  exitCode: number | null;
  signalCode: NodeJS.Signals | null;
  spawnError: string | null;
  stdout: string;
  stderr: string;
};

export type PackagedProcessCapture = {
  snapshot(): PackagedProcessSnapshot;
};

export function capturePackagedProcess(
  child: ChildProcessWithoutNullStreams,
  maxCharacters = 32_000,
): PackagedProcessCapture {
  let stdout = "";
  let stderr = "";
  let spawnError: string | null = null;
  const append = (current: string, chunk: unknown): string =>
    `${current}${String(chunk)}`.slice(-maxCharacters);

  child.stdout.on("data", (chunk) => {
    stdout = append(stdout, chunk);
  });
  child.stderr.on("data", (chunk) => {
    stderr = append(stderr, chunk);
  });
  child.on("error", (error) => {
    spawnError = error instanceof Error ? error.message : String(error);
  });

  return {
    snapshot: () => ({
      exitCode: child.exitCode,
      signalCode: child.signalCode,
      spawnError,
      stdout,
      stderr,
    }),
  };
}

export async function preservePackagedAppLogs(input: {
  appHome: string;
  reportPath?: string;
}): Promise<{ copied: boolean; path: string | null; error: string | null }> {
  if (!input.reportPath) return { copied: false, path: null, error: null };
  const source = path.join(input.appHome, "logs");
  const reportPath = path.resolve(input.reportPath);
  const target = path.join(
    path.dirname(reportPath),
    `${path.basename(reportPath, path.extname(reportPath))}-logs`,
  );
  try {
    if (!(await stat(source).catch(() => null))?.isDirectory()) {
      return { copied: false, path: null, error: null };
    }
    await mkdir(path.dirname(target), { recursive: true });
    await cp(source, target, { recursive: true, force: true });
    return { copied: true, path: path.relative(process.cwd(), target), error: null };
  } catch (error) {
    return {
      copied: false,
      path: null,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

export function errorDetails(error: unknown): { message: string; stack: string | null } {
  return error instanceof Error
    ? { message: error.message, stack: error.stack ?? null }
    : { message: String(error), stack: null };
}
