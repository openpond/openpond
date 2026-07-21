import { useCallback, useEffect, useState } from "react";
import type { DatasetCatalogResponse } from "@openpond/contracts";
import { api, type ClientConnection } from "../../api";

export function useDatasetStorageSettings(input: {
  connection: ClientConnection | null;
  enabled: boolean;
  onError: (message: string | null) => void;
  profileId: string;
}) {
  const { connection, enabled, onError, profileId } = input;
  const [catalog, setCatalog] = useState<DatasetCatalogResponse | null>(null);
  const [loading, setLoading] = useState(false);

  const refresh = useCallback(async () => {
    if (!connection) return;
    setLoading(true);
    try {
      setCatalog(await api.datasetCatalog(connection, profileId));
      onError(null);
    } catch (error) {
      onError(message(error));
    } finally {
      setLoading(false);
    }
  }, [connection, onError, profileId]);

  useEffect(() => {
    if (!enabled) return;
    void refresh();
  }, [enabled, refresh]);

  return { catalog, loading, refresh };
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
