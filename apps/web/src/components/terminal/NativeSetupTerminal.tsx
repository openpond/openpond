import "./native-setup-terminal.css";
import { lazy, Suspense, useState } from "react";
import { createPortal } from "react-dom";
import type { ClientConnection } from "../../api/api-client";
import type { TerminalTab } from "./terminal-overlay-types";

const TerminalOverlay = lazy(() => import("./TerminalOverlay").then((module) => ({ default: module.TerminalOverlay })));

/** Uses the existing authenticated terminal service for native login and the shared Importer CLI. */
export function NativeSetupTerminal({ connection, command, onClose }: { connection: ClientConnection; command: string; onClose(): void }) {
  const [tabs, setTabs] = useState<TerminalTab[]>([]);
  const [scope] = useState(() => ({ kind: "draft" as const, id: `native-setup-${crypto.randomUUID()}` }));
  const [queued] = useState(() => ({ id: Date.now(), scope, command }));
  return createPortal(<div className="native-setup-terminal"><Suspense fallback={<p role="status">Opening setup terminal…</p>}><TerminalOverlay open disposeOnUnmount connection={connection} scope={scope} tabs={tabs} onTabsChange={setTabs} cwd={null} appId={null} workspaceName="Agent setup" queuedCommand={queued} onClose={onClose} /></Suspense></div>, document.body);
}
