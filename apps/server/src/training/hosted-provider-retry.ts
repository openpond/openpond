export function retryableHostedError(error: unknown): boolean {
  const message = hostedErrorText(error);
  return /\b(?:429|500|502|503|504)\b|retryable["':\s]+true|bad gateway|temporar(?:y|ily)|fetch failed|network error|socket hang up|econnreset|econnrefused|etimedout|und_err_(?:connect|socket|headers|body)_timeout/i.test(
    message,
  );
}

function hostedErrorText(error: unknown): string {
  if (!(error instanceof Error)) return String(error);
  const cause = error.cause instanceof Error
    ? `${error.cause.name}: ${error.cause.message}`
    : error.cause === undefined
      ? ""
      : String(error.cause);
  return `${error.name}: ${error.message} ${cause}`;
}

export function hostedRetryDelayMs(error: unknown, retry: number): number {
  const message = error instanceof Error ? error.message : String(error);
  const declared = message.match(/retry_after["']?\s*[:=]\s*(\d+)/i)?.[1];
  if (declared) return Math.min(60_000, Math.max(1_000, Number(declared) * 1_000));
  return Math.min(10_000, 1_000 * 2 ** retry);
}

export async function abortableDelay(
  milliseconds: number,
  signal: AbortSignal,
): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    if (signal.aborted) {
      reject(signal.reason);
      return;
    }
    const onAbort = () => {
      clearTimeout(timer);
      reject(signal.reason);
    };
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, milliseconds);
    signal.addEventListener("abort", onAbort, { once: true });
  });
}
