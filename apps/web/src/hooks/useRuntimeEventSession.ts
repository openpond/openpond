import { useCallback, useEffect, useSyncExternalStore } from "react";
import type { RuntimeEventStore } from "../lib/runtime-event-store";

export function useRuntimeEventSession(
  store: RuntimeEventStore,
  sessionId: string | null,
) {
  const subscribe = useCallback(
    (listener: () => void) =>
      sessionId ? store.subscribeSession(sessionId, listener) : () => undefined,
    [sessionId, store],
  );
  const getSnapshot = useCallback(
    () => store.getSessionSnapshot(sessionId),
    [sessionId, store],
  );
  const snapshot = useSyncExternalStore(subscribe, getSnapshot, getSnapshot);

  useEffect(() => {
    if (!sessionId) return undefined;
    store.retainSession(sessionId, true);
    return () => store.retainSession(sessionId, false);
  }, [sessionId, store]);

  return snapshot;
}
