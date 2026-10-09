/** Share one backend launch between initial load, connection requests and retries. */
export function singleFlightDesktopStartup<T>(start: () => Promise<T>): () => Promise<T> {
  let pending: Promise<T> | null = null;
  return () => {
    if (!pending) {
      pending = Promise.resolve().then(start).finally(() => { pending = null; });
    }
    return pending;
  };
}
