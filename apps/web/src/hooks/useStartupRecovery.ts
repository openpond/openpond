import { useCallback, useEffect, useRef, useState } from "react";
import { startupRequest } from "../startup/startup-request";

/** Own startup attempts so retries and unmounts cannot publish stale snapshots. */
export function useStartupRecovery(run: (signal: AbortSignal) => Promise<void>) {
  const [error, setError] = useState<string | null>(null);
  const [retrying, setRetrying] = useState(false);
  const [generation, setGeneration] = useState(0);
  const active = useRef<{ controller: AbortController; promise: Promise<void> } | null>(null);
  const load = useCallback(() => {
    if (active.current) return active.current.promise;
    const controller = new AbortController();
    setRetrying(true);
    const promise = startupRequest(run, controller.signal)
      .then(() => {
        if (!controller.signal.aborted) setError(null);
      })
      .catch((failure: unknown) => {
        if (!controller.signal.aborted)
          setError(failure instanceof Error ? failure.message : String(failure));
        throw failure;
      })
      .finally(() => {
        if (active.current?.controller === controller) {
          active.current = null;
          setRetrying(false);
        }
      });
    active.current = { controller, promise };
    return promise;
  }, [run]);
  useEffect(() => {
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const attempt = async (number: number) => {
      try {
        await load();
      } catch {
        if (!cancelled && number < 2)
          timer = setTimeout(() => void attempt(number + 1), 1500 * (number + 1));
      }
    };
    void attempt(0);
    return () => {
      cancelled = true;
      clearTimeout(timer);
      active.current?.controller.abort();
      active.current = null;
    };
  }, [load, generation]);
  const retry = useCallback(() => setGeneration((value) => value + 1), []);
  const recover = useCallback(() => {
    void load().catch(() => undefined);
  }, [load]);
  return { error, retrying, retry, recover };
}
