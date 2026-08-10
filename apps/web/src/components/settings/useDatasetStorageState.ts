import { useCallback, useEffect, useState } from "react";
import type { DatasetStorageState } from "@openpond/contracts";
import { api, type ClientConnection } from "../../api";

export function useDatasetStorageState(input: {
  connection: ClientConnection | null;
  enabled: boolean;
  onError: (message: string | null) => void;
}) {
  const [state, setState] = useState<DatasetStorageState | null>(null);
  const [busy, setBusy] = useState<"load" | "save" | null>(null);
  const refresh = useCallback(async () => {
    if (!input.connection) return;
    setBusy("load");
    try {
      setState(await api.datasetStorageState(input.connection));
      input.onError(null);
    } catch (error) {
      input.onError(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(null);
    }
  }, [input.connection, input.onError]);
  const save = useCallback(async (datasetStorePath: string | null) => {
    if (!input.connection || !datasetStorePath) return false;
    setBusy("save");
    try {
      setState(await api.updateDatasetStorage(input.connection, datasetStorePath));
      input.onError(null);
      return true;
    } catch (error) {
      input.onError(error instanceof Error ? error.message : String(error));
      return false;
    } finally {
      setBusy(null);
    }
  }, [input.connection, input.onError]);
  useEffect(() => { if (input.enabled) void refresh(); }, [input.enabled, refresh]);
  return { state, busy, refresh, save };
}
