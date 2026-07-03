import { lazy, Suspense, useEffect, useState, type Dispatch, type SetStateAction } from "react";
import type { TerminalScope } from "@openpond/contracts";
import type { ClientConnection } from "../../api";
import type { TerminalQueuedCommand, TerminalTab } from "../terminal/terminal-overlay-types";

const TerminalOverlay = lazy(() =>
  import("../terminal/TerminalOverlay").then((module) => ({ default: module.TerminalOverlay }))
);

export function AppTerminalPanel({
  open,
  connection,
  scope,
  tabs,
  onTabsChange,
  cwd,
  appId,
  workspaceName,
  queuedCommand,
  onClose,
}: {
  open: boolean;
  connection: ClientConnection | null;
  scope: TerminalScope;
  tabs: TerminalTab[];
  onTabsChange: Dispatch<SetStateAction<TerminalTab[]>>;
  cwd: string | null;
  appId: string | null;
  workspaceName: string | null;
  queuedCommand: TerminalQueuedCommand | null;
  onClose: () => void;
}) {
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    if (open) setLoaded(true);
  }, [open]);

  if (!loaded) return null;

  return (
    <Suspense fallback={null}>
      <TerminalOverlay
        open={open}
        connection={connection}
        scope={scope}
        tabs={tabs}
        onTabsChange={onTabsChange}
        cwd={cwd}
        appId={appId}
        workspaceName={workspaceName}
        queuedCommand={queuedCommand}
        onClose={onClose}
      />
    </Suspense>
  );
}
