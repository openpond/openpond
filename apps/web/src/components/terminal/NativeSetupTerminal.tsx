import "./native-setup-terminal.css";
import { lazy, Suspense, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import type { ClientConnection } from "../../api/api-client";
import type { TerminalTab } from "./terminal-overlay-types";
import { AppDialog } from "../dialogs/AppDialog";

const TerminalOverlay = lazy(() => import("./TerminalOverlay").then((module) => ({ default: module.TerminalOverlay })));

/** Uses the existing authenticated terminal service for native login and the shared Importer CLI. */
export function NativeSetupTerminal({ connection, command, displayCommand = "OpenPond setup", onClose, onComplete, modal = false }: { connection: ClientConnection; command: string; displayCommand?: string; onClose(): void; onComplete?(): void; modal?: boolean }) {
  const [tabs, setTabs] = useState<TerminalTab[]>([]);
  const [scope] = useState(() => ({ kind: "draft" as const, id: `native-setup-${crypto.randomUUID()}` }));
  const completed = useRef(false);
  const [setupCommand] = useState(() => ({ command, displayCommand }));
  useEffect(() => {
    // Setup completion comes from the launched process, independently of
    // shell prompt hooks or normalization of the displayed command.
    if (!completed.current && tabs.some((tab) => tab.lastCommand !== null && tab.lastExitCode === 0 && tab.commandStatus === "success")) {
      completed.current = true;
      onComplete?.();
    }
  }, [tabs, onComplete]);
  const terminal = <Suspense fallback={<p role="status">Opening setup terminal…</p>}><TerminalOverlay open disposeOnUnmount connection={connection} scope={scope} tabs={tabs} onTabsChange={setTabs} cwd={null} appId={null} workspaceName="Agent setup" queuedCommand={null} setupCommand={setupCommand} onClose={onClose} /></Suspense>;
  return createPortal(modal
    ? <AppDialog ariaLabel="Agent setup terminal" backdropClassName="native-setup-modal-backdrop" className="native-setup-terminal" onClose={onClose}>{terminal}</AppDialog>
    : <div className="native-setup-terminal">{terminal}</div>, document.body);
}
