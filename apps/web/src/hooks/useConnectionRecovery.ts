import { useEffect } from "react";
import type { ClientConnection } from "../api/api-client";
import { useConnectionStatus } from "./useConnectionStatus";

/** One recovery loop per shell, independent of whichever page encountered the outage. */
export function useConnectionRecovery(connection: ClientConnection | null, recover: () => void) {
  const { error } = useConnectionStatus(connection);
  useEffect(() => {
    if (!connection || !error) return;
    const timer = window.setInterval(recover, 5_000);
    return () => window.clearInterval(timer);
  }, [connection, error, recover]);
}
