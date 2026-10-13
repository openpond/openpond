import type { ChildProcessWithoutNullStreams } from "node:child_process";
import type { Logger } from "@openpond/logging";
import {
  createReadyLineParser,
  createServerStartupDeadline,
  isStorageStartupProgress,
  STORAGE_STARTUP_PROGRESS_PREFIX,
  type StorageStartupProgress,
} from "@openpond/runtime/ready-line-parser";

/** Share one backend launch between initial load, connection requests and retries. */
export function singleFlightDesktopStartup<T>(start: () => Promise<T>): () => Promise<T> {
  let pending: Promise<T> | null = null;
  return () => {
    if (!pending) {
      pending = Promise.resolve()
        .then(start)
        .finally(() => {
          pending = null;
        });
    }
    return pending;
  };
}

export async function waitForDesktopServerReady(
  child: ChildProcessWithoutNullStreams,
  fallbackUrl: string,
  options: {
    timeoutMs: number;
    logger: Logger;
    onProgress: (progress: StorageStartupProgress) => void;
    onSettled: () => void;
  },
): Promise<string> {
  return new Promise((resolve, reject) => {
    let settled = false;
    const cleanup = () => {
      deadline.stop();
      options.onSettled();
      child.stdout.off("data", onStdout);
      child.stderr.off("data", onStderr);
      child.off("exit", onExit);
      child.off("error", onError);
    };
    const finish = (url: string) => {
      if (settled) return;
      settled = true;
      cleanup();
      options.logger.info("server ready", { url });
      resolve(url);
    };
    const fail = (error: Error) => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(error);
    };
    const parser = createReadyLineParser<{ url?: string }>(
      "OPENPOND_APP_SERVER_READY ",
      (payload) => {
        finish(payload.url || fallbackUrl);
      },
    );
    const deadline = createServerStartupDeadline(options.timeoutMs, () =>
      fail(new Error("OpenPond App server did not start in time")),
    );
    const progressParser = createReadyLineParser<unknown>(
      STORAGE_STARTUP_PROGRESS_PREFIX,
      (progress) => {
        if (!isStorageStartupProgress(progress)) return;
        deadline.progress(progress);
        options.onProgress(progress);
        options.logger.info("storage startup progress", progress);
      },
    );
    const onStdout = (chunk: Buffer) => {
      try {
        progressParser.push(chunk.toString("utf8"));
        parser.push(chunk.toString("utf8"));
      } catch (error) {
        fail(error instanceof Error ? error : new Error(String(error)));
      }
    };
    const onStderr = (chunk: Buffer) => {
      const output = chunk.toString("utf8");
      options.logger.warn("server stderr", { output });
      console.error(output);
    };
    const onExit = (code: number | null) => {
      parser.flush();
      fail(new Error(`OpenPond App server exited with code ${code ?? "unknown"}`));
    };
    const onError = (error: Error) => fail(error);
    child.stdout.on("data", onStdout);
    child.stderr.on("data", onStderr);
    child.once("exit", onExit);
    child.once("error", onError);
  });
}
