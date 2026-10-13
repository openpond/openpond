import { useCallback, useSyncExternalStore } from "react";
import type { ClientConnection } from "../api/api-client";
import { connectionStatus, subscribeConnectionStatus } from "../api/connection-status";

export function useConnectionStatus(connection: ClientConnection | null) {
  const subscribe = useCallback((listener: () => void) => subscribeConnectionStatus(connection, listener), [connection]);
  const snapshot = useCallback(() => connectionStatus(connection), [connection]);
  return useSyncExternalStore(subscribe, snapshot);
}
