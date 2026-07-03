import { memo, useCallback, useEffect, useMemo, useRef, useState, type Dispatch, type SetStateAction } from "react";
import type { TerminalScope } from "@openpond/contracts";
import { ChevronDown, Plus, X } from "../icons";
import { terminalWebSocketProtocols, terminalWebSocketUrl, type ClientConnection } from "../../api";
import { TerminalPane } from "./TerminalPane";
import { terminalQueuedCommandAppliesToScope, terminalScopeKey, terminalScopesEqual, terminalTabsForScope } from "./terminal-state";
import {
  DEFAULT_TERMINAL_COLS,
  DEFAULT_TERMINAL_ROWS,
  createTerminalId,
  exitDetail,
  labelForCwd,
  parseServerMessage,
  type TerminalClientMessage,
  type TerminalHandle,
  type TerminalQueuedCommand,
  type TerminalServerMessage,
  type TerminalTab,
} from "./terminal-overlay-types";

const SUCCESS_STATUS_VISIBLE_MS = 6000;

export const TerminalOverlay = memo(function TerminalOverlay({
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
  const [activeTabIdsByScope, setActiveTabIdsByScope] = useState<Record<string, string | null>>({});
  const [socketOpen, setSocketOpen] = useState(false);
  const [connectionError, setConnectionError] = useState<string | null>(null);
  const [socketRetryKey, setSocketRetryKey] = useState(0);
  const nextTabIndexRef = useRef(1);
  const terminalsRef = useRef<Map<string, TerminalHandle>>(new Map());
  const startedTabsRef = useRef<Set<string>>(new Set());
  const pendingInputRef = useRef<Map<string, string[]>>(new Map());
  const successResetTimeoutsRef = useRef<Map<string, number>>(new Map());
  const socketRef = useRef<WebSocket | null>(null);
  const retryTimeoutRef = useRef<number | null>(null);
  const queuedCommandIdRef = useRef<number | null>(null);
  const wasOpenRef = useRef(false);
  const hasTabs = tabs.length > 0;
  const connectionKey = connection ? `${connection.serverUrl}|${connection.token}` : "disconnected";
  const activeScopeKey = terminalScopeKey(scope);
  const scopedTabs = useMemo(() => terminalTabsForScope(tabs, scope), [scope, tabs]);
  const activeTabId = activeTabIdsByScope[activeScopeKey] ?? scopedTabs[0]?.id ?? null;
  const activeTab = useMemo(
    () => scopedTabs.find((tab) => tab.id === activeTabId) ?? scopedTabs[0] ?? null,
    [activeTabId, scopedTabs]
  );

  const setActiveScopeTabId = useCallback((tabId: string | null) => {
    setActiveTabIdsByScope((current) =>
      current[activeScopeKey] === tabId
        ? current
        : {
            ...current,
            [activeScopeKey]: tabId,
          }
    );
  }, [activeScopeKey]);

  const sendMessage = useCallback((message: TerminalClientMessage): boolean => {
    const socket = socketRef.current;
    if (!socket || socket.readyState !== WebSocket.OPEN) return false;
    socket.send(JSON.stringify(message));
    return true;
  }, []);

  const clearSuccessReset = useCallback((terminalId: string) => {
    const timeout = successResetTimeoutsRef.current.get(terminalId);
    if (typeof timeout === "number") window.clearTimeout(timeout);
    successResetTimeoutsRef.current.delete(terminalId);
  }, []);

  const scheduleSuccessReset = useCallback(
    (terminalId: string, completedAt: number) => {
      clearSuccessReset(terminalId);
      const timeout = window.setTimeout(() => {
        successResetTimeoutsRef.current.delete(terminalId);
        onTabsChange((current) =>
          current.map((tab) =>
            tab.id === terminalId && tab.commandStatus === "success" && tab.updatedAt === completedAt
              ? {
                  ...tab,
                  commandStatus: "idle",
                  updatedAt: Date.now(),
                }
              : tab
          )
        );
      }, SUCCESS_STATUS_VISIBLE_MS);
      successResetTimeoutsRef.current.set(terminalId, timeout);
    },
    [clearSuccessReset, onTabsChange]
  );

  const addTab = useCallback(() => {
    const index = nextTabIndexRef.current++;
    const id = createTerminalId();
    const now = Date.now();
    const nextTab: TerminalTab = {
      id,
      scope,
      title: `Terminal ${index}`,
      cwd,
      appId,
      status: "connecting",
      commandStatus: "unknown",
      lastExitCode: null,
      lastCommand: null,
      shell: null,
      detail: labelForCwd(cwd ?? workspaceName),
      updatedAt: now,
    };
    onTabsChange((current) => [...current, nextTab]);
    setActiveScopeTabId(id);
  }, [appId, cwd, onTabsChange, scope, setActiveScopeTabId, workspaceName]);

  const closeTab = useCallback(
    (terminalId: string) => {
      sendMessage({ type: "kill", terminalId });
      clearSuccessReset(terminalId);
      startedTabsRef.current.delete(terminalId);
      terminalsRef.current.delete(terminalId);
      pendingInputRef.current.delete(terminalId);
      onTabsChange((current) => {
        const closingTab = current.find((tab) => tab.id === terminalId) ?? null;
        const index = current.findIndex((tab) => tab.id === terminalId);
        const next = current.filter((tab) => tab.id !== terminalId);
        if (closingTab) {
          const closingScopeKey = terminalScopeKey(closingTab.scope);
          const nextScopeTabs = next.filter((tab) => terminalScopesEqual(tab.scope, closingTab.scope));
          setActiveTabIdsByScope((currentActive) => {
            if (currentActive[closingScopeKey] !== terminalId) return currentActive;
            return {
              ...currentActive,
              [closingScopeKey]: nextScopeTabs[Math.min(Math.max(index, 0), Math.max(nextScopeTabs.length - 1, 0))]?.id ?? null,
            };
          });
        }
        return next;
      });
    },
    [clearSuccessReset, onTabsChange, sendMessage]
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
        scope: tab.scope,
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
      if (message.terminalId === activeTabId) {
        window.requestAnimationFrame(() => terminalsRef.current.get(message.terminalId)?.focus());
      }
      onTabsChange((current) =>
        current.map((tab) =>
          tab.id === message.terminalId
            ? {
                ...tab,
                cwd: message.cwd,
                status: "running",
                shell: message.shell,
                detail: `${labelForCwd(message.cwd)} · pid ${message.pid}`,
                updatedAt: Date.now(),
              }
            : tab
        )
      );
      return;
    }
    if (message.type === "exit") {
      clearSuccessReset(message.terminalId);
      onTabsChange((current) =>
        current.map((tab) =>
          tab.id === message.terminalId
            ? {
                ...tab,
                status: "exited",
                commandStatus: message.code === 0 ? tab.commandStatus : "failed",
                lastExitCode: message.code,
                detail: exitDetail(message.code, message.signal),
                updatedAt: Date.now(),
              }
            : tab
        )
      );
      return;
    }
    if (message.type === "command_start") {
      clearSuccessReset(message.terminalId);
      onTabsChange((current) =>
        current.map((tab) =>
          tab.id === message.terminalId
            ? {
                ...tab,
                commandStatus: "running",
                lastCommand: message.command,
                updatedAt: Date.now(),
              }
            : tab
        )
      );
      return;
    }
    if (message.type === "command_end") {
      const updatedAt = Date.now();
      if (message.exitCode === 0) {
        scheduleSuccessReset(message.terminalId, updatedAt);
      } else {
        clearSuccessReset(message.terminalId);
      }
      onTabsChange((current) =>
        current.map((tab) =>
          tab.id === message.terminalId
            ? {
                ...tab,
                commandStatus: message.exitCode === 0 ? "success" : "failed",
                lastExitCode: message.exitCode,
                updatedAt,
              }
            : tab
        )
      );
      return;
    }
    if (message.type === "prompt_ready") {
      onTabsChange((current) =>
        current.map((tab) =>
          tab.id === message.terminalId && tab.commandStatus === "unknown"
            ? {
                ...tab,
                commandStatus: "idle",
                updatedAt: Date.now(),
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
      clearSuccessReset(message.terminalId);
      terminalsRef.current.get(message.terminalId)?.write(`\r\n\x1b[31m${message.message}\x1b[0m\r\n`);
      onTabsChange((current) =>
        current.map((tab) =>
          tab.id === message.terminalId
            ? {
                ...tab,
                status: "error",
                commandStatus: "failed",
                detail: message.message,
                updatedAt: Date.now(),
              }
            : tab
        )
      );
    }
  }, [activeTabId, clearSuccessReset, flushPendingInput, onTabsChange, scheduleSuccessReset]);

  useEffect(() => {
    return () => {
      for (const timeout of successResetTimeoutsRef.current.values()) window.clearTimeout(timeout);
      successResetTimeoutsRef.current.clear();
    };
  }, []);

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
      onTabsChange((current) =>
        current.map((tab) =>
          tab.status === "exited"
            ? tab
            : {
                ...tab,
                status: "connecting",
                detail: "Reconnecting",
                updatedAt: Date.now(),
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
  }, [connection, connectionKey, handleServerMessage, hasTabs, onTabsChange, socketRetryKey]);

  useEffect(() => {
    if (!socketOpen) return;
    for (const tab of tabs) {
      if (startedTabsRef.current.has(tab.id) || tab.status === "exited") continue;
      if (startTab(tab)) startedTabsRef.current.add(tab.id);
    }
  }, [socketOpen, startTab, tabs]);

  useEffect(() => {
    if (!open) {
      wasOpenRef.current = false;
      return;
    }
    const openedNow = !wasOpenRef.current;
    wasOpenRef.current = true;
    if (!openedNow || !connection || scopedTabs.length > 0) return;
    addTab();
  }, [addTab, connection, open, scopedTabs.length]);

  useEffect(() => {
    if (scopedTabs.length === 0) return;
    if (activeTabId && scopedTabs.some((tab) => tab.id === activeTabId)) return;
    setActiveScopeTabId(scopedTabs[0].id);
  }, [activeTabId, scopedTabs, setActiveScopeTabId]);

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
    if (!terminalQueuedCommandAppliesToScope(queuedCommand, scope)) return;
    if (queuedCommandIdRef.current === queuedCommand.id) return;
    if (scopedTabs.length === 0 || !activeTabId) {
      addTab();
      return;
    }
    const activeTab = scopedTabs.find((tab) => tab.id === activeTabId);
    if (!activeTab || activeTab.status !== "running") return;
    queuedCommandIdRef.current = queuedCommand.id;
    sendInput(activeTab.id, `${queuedCommand.command}\n`);
  }, [activeTabId, addTab, open, queuedCommand, scope, scopedTabs, sendInput]);

  return (
    <div className={`guake-terminal-overlay ${open ? "open" : ""}`} aria-hidden={!open} inert={open ? undefined : true}>
      <section className="guake-terminal-panel" aria-label="Terminal">
        <div className="guake-terminal-tabs">
          <div className="guake-terminal-tab-list" role="tablist" aria-label="Terminal tabs">
            {scopedTabs.map((tab) => (
              <div
                key={tab.id}
                className={`guake-terminal-tab ${tab.id === activeTabId ? "active" : ""}`}
                role="tab"
                aria-selected={tab.id === activeTabId}
                title={tab.detail ?? tab.title}
              >
                <button type="button" className="guake-terminal-tab-main" onClick={() => setActiveScopeTabId(tab.id)}>
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
          {tabs.map((tab) => (
            <TerminalPane
              key={tab.id}
              tab={tab}
              active={terminalScopesEqual(tab.scope, scope) && tab.id === activeTabId}
              overlayOpen={open}
              registerTerminal={registerTerminal}
              onInput={sendInput}
              onResize={sendResize}
            />
          ))}
          {scopedTabs.length === 0 ? (
            <button type="button" className="guake-terminal-empty" onClick={addTab}>
              <Plus size={16} />
              <span>New terminal tab</span>
            </button>
          ) : null}
        </div>
      </section>
    </div>
  );
});
