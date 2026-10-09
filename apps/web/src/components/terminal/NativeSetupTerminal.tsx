import "./native-setup-terminal.css";
import { lazy, Suspense, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import type { ClientConnection } from "../../api/api-client";
import type { TerminalTab } from "./terminal-overlay-types";

const TerminalOverlay = lazy(() => import("./TerminalOverlay").then((module) => ({ default: module.TerminalOverlay })));

/** Uses the existing authenticated terminal service for native login and the shared Importer CLI. */
export function NativeSetupTerminal({ connection, command, onClose, onComplete }: { connection: ClientConnection; command: string; onClose(): void; onComplete?(): void }) {
  const [tabs, setTabs] = useState<TerminalTab[]>([]);
  const [scope] = useState(() => ({ kind: "draft" as const, id: `native-setup-${crypto.randomUUID()}` }));
  const completed = useRef(false);
  const [queued] = useState(() => ({ id: Date.now(), scope, command }));
  useEffect(() => {
    if (!completed.current && tabs.some((tab) => tab.lastCommand === command && tab.lastExitCode === 0 && tab.commandStatus === "success")) {
      completed.current = true;
      onComplete?.();
    }
  }, [tabs, command, onComplete]);
  return createPortal(<div className="native-setup-terminal"><Suspense fallback={<p role="status">Opening setup terminal…</p>}><TerminalOverlay open disposeOnUnmount connection={connection} scope={scope} tabs={tabs} onTabsChange={setTabs} cwd={null} appId={null} workspaceName="Agent setup" queuedCommand={queued} onClose={onClose} /></Suspense></div>, document.body);
}
