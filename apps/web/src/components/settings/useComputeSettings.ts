import { useCallback, useEffect, useState } from "react";
import type { ComputeStateResponse } from "@openpond/contracts";
import { api, type ClientConnection } from "../../api";

export function useComputeSettings(input: { connection: ClientConnection | null; enabled: boolean; onError: (message: string | null) => void }) {
  const { connection, enabled, onError } = input;
  const [state, setState] = useState<ComputeStateResponse | null>(null);
  const [busy, setBusy] = useState<"load" | "scan" | "save" | null>(null);

  const refresh = useCallback(async () => {
    if (!connection) return;
    setBusy("load");
    try {
      const next = await api.computeState(connection);
      setState(next);
      onError(null);
    } catch (error) { onError(message(error)); }
    finally { setBusy(null); }
  }, [connection, onError]);

  const scan = useCallback(async () => {
    if (!connection) return;
    setBusy("scan");
    try {
      const inventory = await api.scanCompute(connection);
      const next = await api.computeState(connection);
      setState({ ...next, inventory, scanning: false });
      onError(null);
    } catch (error) { onError(message(error)); }
    finally { setBusy(null); }
  }, [connection, onError]);

  const save = useCallback(async (modelStorePath: string | null, defaultDeviceIds: string[]) => {
    if (!connection) return false;
    setBusy("save");
    try {
      const settings = await api.updateComputeSettings(connection, { modelStorePath, defaultDeviceIds });
      const next = await api.computeState(connection);
      setState({ ...next, settings });
      onError(null);
      return true;
    } catch (error) { onError(message(error)); return false; }
    finally { setBusy(null); }
  }, [connection, onError]);

  const downloadSmolLm2 = useCallback(async () => {
    if (!connection) return;
    try { await api.downloadSmolLm2(connection); await refresh(); }
    catch (error) { onError(message(error)); }
  }, [connection, onError, refresh]);

  const cancelDownload = useCallback(async (jobId: string) => {
    if (!connection) return;
    try { await api.cancelModelDownload(connection, jobId); await refresh(); }
    catch (error) { onError(message(error)); }
  }, [connection, onError, refresh]);

  useEffect(() => {
    if (!enabled) return;
    void refresh();
  }, [enabled, refresh]);

  const hasActiveDownload = state?.inventory?.downloads.some((download) => ["queued", "downloading", "verifying", "cancelling"].includes(download.status)) ?? false;
  useEffect(() => {
    if (!enabled || !hasActiveDownload) return;
    const interval = window.setInterval(() => void refresh(), 1_000);
    return () => window.clearInterval(interval);
  }, [enabled, hasActiveDownload, refresh]);

  return { state, busy, refresh, scan, save, downloadSmolLm2, cancelDownload };
}

function message(error: unknown): string { return error instanceof Error ? error.message : String(error); }
