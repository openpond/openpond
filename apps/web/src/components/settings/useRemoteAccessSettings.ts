import { useCallback, useEffect, useRef, useState } from "react";
import type { RemoteAccessStatus } from "@openpond/contracts";
import { api, type ClientConnection } from "../../api";
import { copyToClipboard } from "../../lib/clipboard";

type RemoteAccessBusy =
  | "refresh"
  | "enable"
  | "disable"
  | "copy-link"
  | "copy-up-command"
  | "copy-command"
  | "copy-serve-setup"
  | "copy-operator"
  | null;

export function useRemoteAccessSettings({
  connection,
  enabled,
  onError,
  onToast,
}: {
  connection: ClientConnection | null;
  enabled: boolean;
  onError: (message: string | null) => void;
  onToast?: (message: string, tone?: "success" | "error" | "info") => void;
}) {
  const [status, setStatus] = useState<RemoteAccessStatus | null>(null);
  const [busy, setBusy] = useState<RemoteAccessBusy>(null);
  const [flashTailscaleUp, setFlashTailscaleUp] = useState(false);
  const flashTimer = useRef<number | null>(null);

  const refresh = useCallback(
    async (options: { quiet?: boolean } = {}) => {
      if (!connection) return;
      if (!options.quiet) setBusy("refresh");
      try {
        const next = await api.remoteAccess(connection);
        setStatus(next);
        onError(null);
      } catch (error) {
        onError(error instanceof Error ? error.message : String(error));
      } finally {
        if (!options.quiet) setBusy(null);
      }
    },
    [connection, onError],
  );

  useEffect(() => {
    if (!enabled || !connection) return;
    void refresh({ quiet: true });
  }, [connection, enabled, refresh]);

  useEffect(
    () => () => {
      if (flashTimer.current !== null) window.clearTimeout(flashTimer.current);
    },
    [],
  );

  function flashTailscaleUpRow() {
    if (flashTimer.current !== null) window.clearTimeout(flashTimer.current);
    setFlashTailscaleUp(false);
    window.setTimeout(() => {
      setFlashTailscaleUp(true);
      flashTimer.current = window.setTimeout(() => {
        setFlashTailscaleUp(false);
        flashTimer.current = null;
      }, 1500);
    }, 0);
  }

  async function handleRemoteAccessError() {
    onError(null);
    if (!connection) return;
    try {
      setStatus(await api.remoteAccess(connection));
    } catch {
      // Keep remote access failures out of the app-wide toast surface.
    }
  }

  async function enableRemoteAccess(): Promise<RemoteAccessStatus | null> {
    if (!connection) return null;
    if (status && !status.tailscale.running) flashTailscaleUpRow();
    setBusy("enable");
    try {
      const result = await api.enableRemoteAccess(connection);
      setStatus(result.status);
      onError(null);
      if (!result.status.tailscale.running) {
        flashTailscaleUpRow();
        onToast?.(
          result.message || "Tailscale is not running. Run Tailscale up first.",
          "error",
        );
      } else if (!result.status.serve.enabled && result.status.serve.error) {
        onToast?.(
          result.status.serve.setupUrl
            ? "Tailscale Serve needs to be enabled for this tailnet. Copy the Enable Serve link."
            : result.message || result.status.serve.error,
          "error",
        );
      }
      return result.status;
    } catch {
      await handleRemoteAccessError();
      flashTailscaleUpRow();
      onToast?.("Unable to turn on remote access. Run Tailscale up first.", "error");
      return null;
    } finally {
      setBusy(null);
    }
  }

  async function disableRemoteAccess() {
    if (!connection) return;
    if (
      !window.confirm(
        "Turn off remote access? This runs tailscale serve reset and clears Tailscale Serve config on this device.",
      )
    )
      return;
    setBusy("disable");
    try {
      const result = await api.disableRemoteAccess(connection);
      setStatus(result.status);
      onError(null);
    } catch {
      await handleRemoteAccessError();
    } finally {
      setBusy(null);
    }
  }

  async function copyRemoteLink() {
    if (!status?.remoteWebUrl) return;
    setBusy("copy-link");
    await copyToClipboard(status.remoteWebUrl);
    setBusy(null);
  }

  async function copyServeCommand() {
    if (!status?.serveCommand) return;
    setBusy("copy-command");
    await copyToClipboard(status.serveCommand);
    setBusy(null);
  }

  async function copyServeSetupUrl() {
    if (!status?.serve.setupUrl) return;
    setBusy("copy-serve-setup");
    await copyToClipboard(status.serve.setupUrl);
    setBusy(null);
  }

  async function copyTailscaleUpCommand() {
    if (!status?.tailscaleUpCommand) return;
    setBusy("copy-up-command");
    await copyToClipboard(status.tailscaleUpCommand);
    setBusy(null);
  }

  async function copyOperatorCommand() {
    if (!status?.operatorCommand) return;
    setBusy("copy-operator");
    await copyToClipboard(status.operatorCommand);
    setBusy(null);
  }

  async function createRemoteLink() {
    if (!status?.serve.enabled) {
      const nextStatus = await enableRemoteAccess();
      if (nextStatus?.serve.enabled && nextStatus.remoteWebUrl) {
        await copyToClipboard(nextStatus.remoteWebUrl);
      }
      return;
    }
    await copyRemoteLink();
  }

  return {
    status,
    busy,
    flashTailscaleUp,
    refresh,
    enableRemoteAccess,
    disableRemoteAccess,
    copyRemoteLink,
    copyTailscaleUpCommand,
    copyServeCommand,
    copyServeSetupUrl,
    copyOperatorCommand,
    createRemoteLink,
  };
}
