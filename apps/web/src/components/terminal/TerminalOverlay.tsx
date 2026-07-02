import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ChevronDown, Plus, X } from "../icons";
import { terminalWebSocketProtocols, terminalWebSocketUrl, type ClientConnection } from "../../api";
import { TerminalPane } from "./TerminalPane";
import {
  DEFAULT_TERMINAL_COLS,
  DEFAULT_TERMINAL_ROWS,
  createTerminalId,
  exitDetail,
  labelForCwd,
  parseServerMessage,
  type TerminalClientMessage,
  type TerminalHandle,
  type TerminalServerMessage,
  type TerminalTab,
} from "./terminal-overlay-types";

export const TerminalOverlay = memo(function TerminalOverlay({
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
  const [tabs, setTabs] = useState<TerminalTab[]>([]);
  const [activeTabId, setActiveTabId] = useState<string | null>(null);
  const [socketOpen, setSocketOpen] = useState(false);
  const [connectionError, setConnectionError] = useState<string | null>(null);
  const [socketRetryKey, setSocketRetryKey] = useState(0);
  const nextTabIndexRef = useRef(1);
  const terminalsRef = useRef<Map<string, TerminalHandle>>(new Map());
  const startedTabsRef = useRef<Set<string>>(new Set());
  const pendingInputRef = useRef<Map<string, string[]>>(new Map());
  const socketRef = useRef<WebSocket | null>(null);
  const retryTimeoutRef = useRef<number | null>(null);
  const suppressAutoCreateRef = useRef(false);
  const queuedCommandIdRef = useRef<number | null>(null);
  const hasTabs = tabs.length > 0;
  const connectionKey = connection ? `${connection.serverUrl}|${connection.token}` : "disconnected";
  const activeTab = useMemo(() => tabs.find((tab) => tab.id === activeTabId) ?? null, [activeTabId, tabs]);

  const sendMessage = useCallback((message: TerminalClientMessage): boolean => {
    const socket = socketRef.current;
    if (!socket || socket.readyState !== WebSocket.OPEN) return false;
    socket.send(JSON.stringify(message));
    return true;
  }, []);

  const addTab = useCallback(() => {
    const index = nextTabIndexRef.current++;
    const id = createTerminalId();
    const nextTab: TerminalTab = {
      id,
      title: `Terminal ${index}`,
      cwd,
      appId,
      status: "connecting",
      shell: null,
      detail: labelForCwd(cwd ?? workspaceName),
    };
    suppressAutoCreateRef.current = false;
    setTabs((current) => [...current, nextTab]);
    setActiveTabId(id);
  }, [appId, cwd, workspaceName]);

  const closeTab = useCallback(
    (terminalId: string) => {
      sendMessage({ type: "kill", terminalId });
      startedTabsRef.current.delete(terminalId);
      terminalsRef.current.delete(terminalId);
      setTabs((current) => {
        const index = current.findIndex((tab) => tab.id === terminalId);
        const next = current.filter((tab) => tab.id !== terminalId);
        setActiveTabId((activeId) => {
          if (activeId !== terminalId) return activeId;
          return next[Math.min(Math.max(index, 0), Math.max(next.length - 1, 0))]?.id ?? null;
        });
        if (next.length === 0) {
          suppressAutoCreateRef.current = true;
          window.setTimeout(onClose, 0);
        }
        return next;
      });
    },
    [onClose, sendMessage]
  );

  const registerTerminal = useCallback((terminalId: string, handle: TerminalHandle) => {
    terminalsRef.current.set(terminalId, handle);
    return () => {
      if (terminalsRef.current.get(terminalId) === handle) terminalsRef.current.delete(terminalId);
    };
  }, []);

  const sendResize = useCallback(
    (terminalId: string, cols: number, rows: number) => {
      sendMessage({ type: "resize", terminalId, cols, rows });
    },
    [sendMessage]
  );

  const sendInput = useCallback(
    (terminalId: string, data: string) => {
      if (sendMessage({ type: "input", terminalId, data })) return;
      const pending = pendingInputRef.current.get(terminalId) ?? [];
      pending.push(data);
      pendingInputRef.current.set(terminalId, pending);
    },
    [sendMessage]
  );

  const flushPendingInput = useCallback(
    (terminalId: string) => {
      const pending = pendingInputRef.current.get(terminalId);
      if (!pending?.length) return;
      pendingInputRef.current.delete(terminalId);
      for (const data of pending) sendMessage({ type: "input", terminalId, data });
    },
    [sendMessage]
  );

  const startTab = useCallback(
    (tab: TerminalTab): boolean => {
      const dimensions = terminalsRef.current.get(tab.id)?.prepareForStart() ?? {
        cols: DEFAULT_TERMINAL_COLS,
        rows: DEFAULT_TERMINAL_ROWS,
      };
      return sendMessage({
        type: "start",
        terminalId: tab.id,
        cwd: tab.cwd,
        appId: tab.appId,
        cols: dimensions.cols,
        rows: dimensions.rows,
      });
    },
    [sendMessage]
  );

  const handleServerMessage = useCallback((message: TerminalServerMessage) => {
    if (message.type === "output") {
      terminalsRef.current.get(message.terminalId)?.write(message.data);
      return;
    }
    if (message.type === "ready") {
      flushPendingInput(message.terminalId);
      window.requestAnimationFrame(() => terminalsRef.current.get(message.terminalId)?.focus());
      setTabs((current) =>
        current.map((tab) =>
          tab.id === message.terminalId
            ? {
                ...tab,
                cwd: message.cwd,
                status: "running",
                shell: message.shell,
                detail: `${labelForCwd(message.cwd)} · pid ${message.pid}`,
              }
            : tab
        )
      );
      return;
    }
    if (message.type === "exit") {
      setTabs((current) =>
        current.map((tab) =>
          tab.id === message.terminalId
            ? {
                ...tab,
                status: "exited",
                detail: exitDetail(message.code, message.signal),
              }
            : tab
        )
      );
      return;
    }
    if (message.type === "error") {
      if (!message.terminalId) {
        setConnectionError(message.message);
        return;
      }
      terminalsRef.current.get(message.terminalId)?.write(`\r\n\x1b[31m${message.message}\x1b[0m\r\n`);
      setTabs((current) =>
        current.map((tab) =>
          tab.id === message.terminalId
            ? {
                ...tab,
                status: "error",
                detail: message.message,
              }
            : tab
        )
      );
    }
  }, [flushPendingInput]);

  useEffect(() => {
    if (!connection || !hasTabs) {
      setSocketOpen(false);
      return undefined;
    }

    let closedByCleanup = false;
    setConnectionError(null);
    setSocketOpen(false);
    const socket = new WebSocket(terminalWebSocketUrl(connection), terminalWebSocketProtocols(connection));
    socketRef.current = socket;

    socket.addEventListener("open", () => {
      if (socketRef.current !== socket) return;
      startedTabsRef.current.clear();
      setConnectionError(null);
      setSocketOpen(true);
    });
    socket.addEventListener("message", (event) => {
      const payload = parseServerMessage(String(event.data));
      if (payload) handleServerMessage(payload);
    });
    socket.addEventListener("close", () => {
      if (socketRef.current === socket) socketRef.current = null;
      startedTabsRef.current.clear();
      setSocketOpen(false);
      if (closedByCleanup) return;
      setTabs((current) =>
        current.map((tab) =>
          tab.status === "exited"
            ? tab
            : {
                ...tab,
                status: "connecting",
                detail: "Reconnecting",
              }
        )
      );
      if (retryTimeoutRef.current) window.clearTimeout(retryTimeoutRef.current);
      retryTimeoutRef.current = window.setTimeout(() => setSocketRetryKey((current) => current + 1), 900);
    });
    socket.addEventListener("error", () => {
      setConnectionError("Terminal connection failed");
    });

    return () => {
      closedByCleanup = true;
      if (retryTimeoutRef.current) {
        window.clearTimeout(retryTimeoutRef.current);
        retryTimeoutRef.current = null;
      }
      if (socketRef.current === socket) socketRef.current = null;
      socket.close();
    };
  }, [connection, connectionKey, handleServerMessage, hasTabs, socketRetryKey]);

  useEffect(() => {
    if (!socketOpen) return;
    for (const tab of tabs) {
      if (startedTabsRef.current.has(tab.id) || tab.status === "exited") continue;
      if (startTab(tab)) startedTabsRef.current.add(tab.id);
    }
  }, [socketOpen, startTab, tabs]);

  useEffect(() => {
    if (!open) {
      suppressAutoCreateRef.current = false;
      return;
    }
    if (!connection || tabs.length > 0 || suppressAutoCreateRef.current) return;
    addTab();
  }, [addTab, connection, open, tabs.length]);

  useEffect(() => {
    if (!open || !activeTabId) return;
    const frame = window.requestAnimationFrame(() => {
      const terminal = terminalsRef.current.get(activeTabId);
      terminal?.fit();
      terminal?.focus();
    });
    return () => window.cancelAnimationFrame(frame);
  }, [activeTabId, open]);

  useEffect(() => {
    if (!open || !queuedCommand) return;
    if (queuedCommandIdRef.current === queuedCommand.id) return;
    if (tabs.length === 0 || !activeTabId) {
      addTab();
      return;
    }
    const activeTab = tabs.find((tab) => tab.id === activeTabId);
    if (!activeTab || activeTab.status !== "running") return;
    queuedCommandIdRef.current = queuedCommand.id;
    sendInput(activeTab.id, `${queuedCommand.command}\n`);
  }, [activeTabId, addTab, open, queuedCommand, sendInput, tabs]);

  return (
    <div className={`guake-terminal-overlay ${open ? "open" : ""}`} aria-hidden={!open} inert={open ? undefined : true}>
      <section className="guake-terminal-panel" aria-label="Terminal">
        <div className="guake-terminal-tabs">
          <div className="guake-terminal-tab-list" role="tablist" aria-label="Terminal tabs">
            {tabs.map((tab) => (
              <div
                key={tab.id}
                className={`guake-terminal-tab ${tab.id === activeTabId ? "active" : ""}`}
                role="tab"
                aria-selected={tab.id === activeTabId}
                title={tab.detail ?? tab.title}
              >
                <button type="button" className="guake-terminal-tab-main" onClick={() => setActiveTabId(tab.id)}>
                  <span className={`terminal-status-dot ${tab.status}`} />
                  <span className="guake-terminal-tab-title">{tab.shell ?? tab.title}</span>
                </button>
                <button
                  type="button"
                  className="guake-terminal-tab-close"
                  title="Close tab"
                  aria-label={`Close ${tab.title}`}
                  onClick={(event) => {
                    event.stopPropagation();
                    closeTab(tab.id);
                  }}
                >
                  <X size={13} />
                </button>
              </div>
            ))}
          </div>
          <button type="button" className="guake-terminal-icon-button" title="New terminal tab" onClick={addTab}>
            <Plus size={15} />
          </button>
          <div className="guake-terminal-spacer" />
          {activeTab?.detail && <div className="guake-terminal-cwd">{activeTab.detail}</div>}
          {connectionError && <div className="guake-terminal-error">{connectionError}</div>}
          <button type="button" className="guake-terminal-icon-button" title="Hide terminal" onClick={onClose}>
            <ChevronDown size={16} />
          </button>
        </div>
        <div
          className="guake-terminal-body"
          onPointerDown={() => {
            if (activeTabId) terminalsRef.current.get(activeTabId)?.focus();
          }}
        >
          {tabs.length === 0 ? (
            <button type="button" className="guake-terminal-empty" onClick={addTab}>
              <Plus size={16} />
              <span>New terminal tab</span>
            </button>
          ) : (
            tabs.map((tab) => (
              <TerminalPane
                key={tab.id}
                tab={tab}
                active={tab.id === activeTabId}
                overlayOpen={open}
                registerTerminal={registerTerminal}
                onInput={sendInput}
                onResize={sendResize}
              />
            ))
          )}
        </div>
      </section>
    </div>
  );
});
