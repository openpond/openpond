import { useEffect, useState } from "react";
import { buildConnectedAppStatusRows, type ConnectedAppStatusRow } from "@openpond/contracts";
import { api, type ClientConnection } from "../api";

export function useConnectedAppStatusRows(
  connection: ClientConnection | null,
  workspaceId: string | null,
): ConnectedAppStatusRow[] {
  const [rows, setRows] = useState<ConnectedAppStatusRow[]>(() => buildConnectedAppStatusRows());

  useEffect(() => {
    let active = true;
    if (!connection || !workspaceId) {
      setRows(buildConnectedAppStatusRows());
      return () => {
        active = false;
      };
    }
    void api
      .connectedAppStatus(connection, { status: "all", teamId: workspaceId })
      .then((payload) => {
        if (active) setRows(payload.apps);
      })
      .catch((error) => {
        console.warn("Unable to load connected app mention status.", error);
        if (active) setRows(buildConnectedAppStatusRows());
      });
    return () => {
      active = false;
    };
  }, [connection, workspaceId]);

  return rows;
}
