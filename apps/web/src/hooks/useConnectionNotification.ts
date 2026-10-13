import { useEffect } from "react";
import { useQueryClient } from "@tanstack/react-query";
import type { Dispatch } from "react";
import type { ClientConnection } from "../api/api-client";
import type { AppAction, ShowAppToast } from "../app/app-state";
import { useConnectionStatus } from "./useConnectionStatus";
import { isConnectionErrorMessage } from "../lib/error-messages";

export function useConnectionNotification(connection: ClientConnection | null, showToast: ShowAppToast, dispatch: Dispatch<AppAction>) {
  const status = useConnectionStatus(connection);
  const queries = useQueryClient();
  useEffect(() => {
    if (!status.error) return;
    const id = showToast(status.error, "error", {
      dedupeKey: "openpond-connection", groupKey: "openpond-connection",
      detail: "Reconnecting automatically…",
    });
    return () => { dispatch({ type: "clearToast", toastId: id }); };
  }, [status.error, showToast, dispatch]);
  useEffect(() => {
    if (!status.recovery || status.error) return;
    void queries.refetchQueries({ type: "active", predicate: query => {
      const error = query.state.error;
      return query.state.status === "error" && error instanceof Error && isConnectionErrorMessage(error.message);
    } });
  }, [status.recovery, status.error, queries]);
}
