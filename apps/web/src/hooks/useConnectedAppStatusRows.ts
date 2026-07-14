import { useEffect, useState } from "react";
import { buildConnectedAppStatusRows, type ConnectedAppStatusRow } from "@openpond/contracts";
import { api, type ClientConnection } from "../api";

export function useConnectedAppStatusRows(connection: ClientConnection | null): ConnectedAppStatusRow[] {
  const [rows, setRows] = useState<ConnectedAppStatusRow[]>(() => buildConnectedAppStatusRows());

  useEffect(() => {
    let active = true;
    if (!connection) {
      setRows(buildConnectedAppStatusRows());
      return () => {
        active = false;
      };
    }
    void api
      .connectedAppStatus(connection, { status: "all" })
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
  }, [connection]);

  return rows;
}
