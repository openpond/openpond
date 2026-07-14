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
