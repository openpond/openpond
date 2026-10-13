import { useEffect, useRef } from "react";
import type { ClientConnection } from "../api/api-client";
import { isConnectionErrorMessage } from "../lib/error-messages";
import { useConnectionStatus } from "./useConnectionStatus";

/** Retry a failed read after recovery; callers must never pass a mutation here. */
export function useConnectionReadRetry(connection: ClientConnection | null, error: string | null, retry: () => void) {
  const { recovery } = useConnectionStatus(connection);
  const previous = useRef(recovery);
  useEffect(() => {
    const changed = previous.current !== recovery;
    previous.current = recovery;
    if (changed && error && isConnectionErrorMessage(error)) retry();
  }, [recovery, error, retry]);
}
