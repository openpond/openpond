import { lazy, Suspense, useEffect, useState } from "react";
import type { ClientConnection } from "../../api";

const TerminalOverlay = lazy(() =>
  import("../terminal/TerminalOverlay").then((module) => ({ default: module.TerminalOverlay }))
);

export function AppTerminalPanel({
  open,
  connection,
  cwd,
  appId,
  workspaceName,
  queuedCommand,
  onClose,
}: {
  open: boolean;
  connection: ClientConnection | null;
  cwd: string | null;
  appId: string | null;
  workspaceName: string | null;
  queuedCommand: { id: number; command: string } | null;
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
        cwd={cwd}
        appId={appId}
        workspaceName={workspaceName}
        queuedCommand={queuedCommand}
        onClose={onClose}
      />
    </Suspense>
  );
}
