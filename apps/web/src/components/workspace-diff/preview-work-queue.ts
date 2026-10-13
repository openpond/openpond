/** Thumbnail renderers share the UI thread. Yield between them and cancel
 * queued work when its card disappears so opening a document takes priority. */
export function createPreviewWorkQueue(yieldToInput = () => new Promise<void>(resolve => setTimeout(resolve, 0))) {
  let tail = Promise.resolve();
  return (signal: AbortSignal, work: () => Promise<void>): Promise<void> => {
    const result = tail.then(async () => {
      if (signal.aborted) return;
      await yieldToInput();
      if (signal.aborted) return;
      let onAbort: () => void = () => {};
      const cancelled = new Promise<void>(resolve => { onAbort = resolve; signal.addEventListener("abort", onAbort, { once: true }); });
      try { await Promise.race([work(), cancelled]); }
      finally { signal.removeEventListener("abort", onAbort); }
    });
    tail = result.catch(() => {});
    return result;
  };
}

export const queueThumbnailPreview = createPreviewWorkQueue();
