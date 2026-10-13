/** Bound startup, including desktop connection discovery and response-body reads. */
export async function startupRequest<T>(
  run: (signal: AbortSignal) => Promise<T>,
  signal: AbortSignal,
  timeoutMs = 30_000,
): Promise<T> {
  const controller = new AbortController();
  const abort = () => controller.abort(signal.reason);
  signal.addEventListener("abort", abort, { once: true });
  if (signal.aborted) abort();
  const timer = setTimeout(
    () =>
      controller.abort(
        new Error("OpenPond took too long to respond. Check the server connection and try again."),
      ),
    timeoutMs,
  );
  let onAbort: () => void = () => {};
  try {
    controller.signal.throwIfAborted();
    return await Promise.race([
      run(controller.signal),
      new Promise<never>((_, reject) => {
        onAbort = () => reject(controller.signal.reason);
        controller.signal.addEventListener("abort", onAbort, { once: true });
        if (controller.signal.aborted) onAbort();
      }),
    ]);
  } finally {
    clearTimeout(timer);
    signal.removeEventListener("abort", abort);
    controller.signal.removeEventListener("abort", onAbort);
    controller.abort();
  }
}
