import { useCallback, useEffect, useRef } from "react";
import type { RuntimeEvent } from "@openpond/contracts";
import { api, type ClientConnection } from "../api";

function isMissingMacOSGitToolsMessage(value: string | null | undefined): boolean {
  return Boolean(
    value &&
      value.includes("Git is required for OpenPond app workspaces") &&
      value.includes("Command Line Tools")
  );
}

export function useGitSetupNotifications(params: {
  connection: ClientConnection | null;
  events: RuntimeEvent[];
  showToast: (
    message: string,
    tone?: "success" | "error" | "info",
    options?: { actionLabel?: string; onAction?: () => void; persistent?: boolean }
  ) => void;
}) {
  const { connection, events, showToast } = params;
  const notifiedGitEventIds = useRef<Set<string>>(new Set());

  const startMacOSCommandLineToolsInstall = useCallback(async () => {
    if (!connection) return;
    try {
      const result = await api.installMacOSCommandLineTools(connection);
      showToast(result.message, "info");
    } catch (installError) {
      showToast(installError instanceof Error ? installError.message : String(installError), "error");
    }
  }, [connection, showToast]);

  const showGitSetupToast = useCallback((message = "OpenPond needs Git to create and sync local projects.") => {
    showToast(message, "error", {
      actionLabel: "Install Tools",
      onAction: () => void startMacOSCommandLineToolsInstall(),
      persistent: true,
    });
  }, [showToast, startMacOSCommandLineToolsInstall]);

  useEffect(() => {
    if (!connection) return;
    let cancelled = false;
    api.gitAvailability(connection)
      .then((result) => {
        if (cancelled || result.ok || result.installAction !== "macos_command_line_tools") return;
        showGitSetupToast("OpenPond needs Git before it can create local projects.");
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [connection, showGitSetupToast]);

  useEffect(() => {
    for (const item of events) {
      if (notifiedGitEventIds.current.has(item.id)) continue;
      const message = item.error ?? item.output ?? null;
      if (
        item.name === "workspace_action_result" &&
        item.status === "failed" &&
        isMissingMacOSGitToolsMessage(message)
      ) {
        notifiedGitEventIds.current.add(item.id);
        showGitSetupToast("OpenPond needs Git before it can update this project.");
      }
    }
  }, [events, showGitSetupToast]);
}
