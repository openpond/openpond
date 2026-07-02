import { memo, useEffect, useRef } from "react";
import { FitAddon } from "@xterm/addon-fit";
import { Terminal } from "@xterm/xterm";
import "@xterm/xterm/css/xterm.css";
import { MOVE_CURSOR_TO_LAST_ROW, type TerminalHandle, type TerminalTab } from "./terminal-overlay-types";

export const TerminalPane = memo(function TerminalPane({
  tab,
  active,
  overlayOpen,
  registerTerminal,
  onInput,
  onResize,
}: {
  tab: TerminalTab;
  active: boolean;
  overlayOpen: boolean;
  registerTerminal: (terminalId: string, handle: TerminalHandle) => () => void;
  onInput: (terminalId: string, data: string) => void;
  onResize: (terminalId: string, cols: number, rows: number) => void;
}) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const terminalRef = useRef<Terminal | null>(null);
  const fitRef = useRef<FitAddon | null>(null);
  const cursorPrimedRef = useRef(false);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return undefined;

    const terminal = new Terminal({
      allowProposedApi: false,
      cursorBlink: true,
      cursorStyle: "bar",
      fontFamily: '"JetBrains Mono", "SFMono-Regular", Consolas, "Liberation Mono", monospace',
      fontSize: 13,
      letterSpacing: 0,
      lineHeight: 1.18,
      scrollback: 10000,
    });
    const fit = new FitAddon();
    terminal.loadAddon(fit);
    terminal.open(container);
    terminalRef.current = terminal;
    fitRef.current = fit;

    const inputDisposable = terminal.onData((data) => onInput(tab.id, data));
    const resizeDisposable = terminal.onResize(({ cols, rows }) => onResize(tab.id, cols, rows));
    const fitToContainer = () => {
      if (!container.offsetWidth || !container.offsetHeight) return false;
      fit.fit();
      return true;
    };
    const primeInitialCursor = () => {
      if (cursorPrimedRef.current) return;
      cursorPrimedRef.current = true;
      terminal.write(MOVE_CURSOR_TO_LAST_ROW);
    };
    const unregister = registerTerminal(tab.id, {
      write: (data) => terminal.write(data),
      focus: () => terminal.focus(),
      fit: () => {
        fitToContainer();
      },
      prepareForStart: () => {
        fitToContainer();
        primeInitialCursor();
        return { cols: terminal.cols, rows: terminal.rows };
      },
    });

    let frame = 0;
    const fitAndNotify = () => {
      frame = 0;
      if (!fitToContainer()) return;
      onResize(tab.id, terminal.cols, terminal.rows);
    };
    const scheduleFit = () => {
      if (frame) window.cancelAnimationFrame(frame);
      frame = window.requestAnimationFrame(fitAndNotify);
    };
    const observer = new ResizeObserver(scheduleFit);
    observer.observe(container);
    scheduleFit();

    return () => {
      if (frame) window.cancelAnimationFrame(frame);
      observer.disconnect();
      unregister();
      inputDisposable.dispose();
      resizeDisposable.dispose();
      fit.dispose();
      terminal.dispose();
      terminalRef.current = null;
      fitRef.current = null;
    };
  }, [onInput, onResize, registerTerminal, tab.id]);

  useEffect(() => {
    if (!active || !overlayOpen) return;
    const frame = window.requestAnimationFrame(() => {
      if (containerRef.current?.offsetWidth && containerRef.current.offsetHeight) {
        fitRef.current?.fit();
        terminalRef.current?.focus();
      }
    });
    return () => window.cancelAnimationFrame(frame);
  }, [active, overlayOpen]);

  return (
    <div
      className={`guake-terminal-pane ${active ? "active" : ""}`}
      ref={containerRef}
      role="tabpanel"
      aria-hidden={!active}
      inert={active ? undefined : true}
    />
  );
});
