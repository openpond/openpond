export type ReadyLineParser<T = unknown> = {
  push(chunk: string): void;
  flush(): void;
  /** Type-only marker preserving the parser's payload contract for consumers. */
  readonly __payloadType?: T;
};

export function createReadyLineParser<T>(
  prefix: string,
  onReady: (payload: T) => void,
): ReadyLineParser<T> {
  let buffer = "";

  const processLine = (line: string) => {
    if (!line.startsWith(prefix)) return;
    onReady(JSON.parse(line.slice(prefix.length)) as T);
  };

  return {
    push(chunk: string) {
      buffer += chunk;
      while (true) {
        const lineEnd = nextLineEnd(buffer);
        if (lineEnd < 0) return;
        const line = buffer.slice(0, lineEnd).replace(/\r$/, "");
        const newlineLength = buffer[lineEnd] === "\r" && buffer[lineEnd + 1] === "\n" ? 2 : 1;
        buffer = buffer.slice(lineEnd + newlineLength);
        processLine(line);
      }
    },
    flush() {
      const line = buffer.trimEnd();
      buffer = "";
      if (line) processLine(line);
    },
  };
}

function nextLineEnd(value: string): number {
  const lf = value.indexOf("\n");
  const cr = value.indexOf("\r");
  if (lf < 0) return cr;
  if (cr < 0) return lf;
  return Math.min(lf, cr);
}

export const STORAGE_STARTUP_PROGRESS_PREFIX = "OPENPOND_STORAGE_PROGRESS ";
export type StorageStartupProgress = {
  phase: "backup" | "verify" | "migrate" | "complete";
  message: string;
  percent?: number;
};

export function isStorageStartupProgress(value: unknown): value is StorageStartupProgress {
  if (!value || typeof value !== "object") return false;
  const progress = value as StorageStartupProgress;
  return (
    ["backup", "verify", "migrate", "complete"].includes(progress.phase) &&
    typeof progress.message === "string" &&
    progress.message.length <= 200 &&
    (progress.percent === undefined ||
      (Number.isFinite(progress.percent) && progress.percent >= 0 && progress.percent <= 100))
  );
}

/** Ordinary startup stays bounded; a declared storage upgrade needs room to
 * copy and verify a large database. Completion restores the ordinary deadline. */
export function createServerStartupDeadline(timeoutMs: number, expired: () => void) {
  let stopped = false;
  let timer = setTimeout(expired, timeoutMs);
  return {
    progress(value: StorageStartupProgress) {
      if (stopped) return;
      clearTimeout(timer);
      timer = setTimeout(
        expired,
        value.phase === "complete" ? timeoutMs : Math.max(timeoutMs, 30 * 60_000),
      );
    },
    stop() {
      stopped = true;
      clearTimeout(timer);
    },
  };
}
