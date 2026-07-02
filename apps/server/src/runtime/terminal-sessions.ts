import { Buffer } from "node:buffer";
import { existsSync, statSync } from "node:fs";
import path from "node:path";
import type { Duplex } from "node:stream";
import type { IncomingMessage } from "node:http";
import type { IPty, IDisposable } from "node-pty";
import { spawn as spawnPty } from "node-pty";
import { WebSocket, WebSocketServer, type RawData } from "ws";
import { hasAuth } from "../api/http.js";

export const TERMINAL_WEBSOCKET_PROTOCOL = "openpond-terminal";
export const TERMINAL_WEBSOCKET_TOKEN_PROTOCOL_PREFIX = "openpond-token.";

type TerminalLogger = {
  info(message: string, metadata?: Record<string, unknown>): void;
  warn(message: string, metadata?: Record<string, unknown>): void;
  error(message: string, metadata?: Record<string, unknown>): void;
};

type TerminalClientMessage =
  | {
      type: "start";
      terminalId: string;
      cwd?: string | null;
      appId?: string | null;
      cols?: number;
      rows?: number;
    }
  | {
      type: "input";
      terminalId: string;
      data: string;
    }
  | {
      type: "resize";
      terminalId: string;
      cols: number;
      rows: number;
    }
  | {
      type: "kill";
      terminalId: string;
    };

type TerminalSession = {
  id: string;
  pty: IPty;
  disposables: IDisposable[];
  socket: WebSocket | null;
  cleanupTimer: NodeJS.Timeout | null;
  cwd: string;
  shell: string;
  pid: number;
  cols: number;
  rows: number;
  outputBuffer: string;
};

const DISCONNECTED_SESSION_TTL_MS = 8000;
const MAX_OUTPUT_BUFFER_CHARS = 80000;
const MIN_COLS = 20;
const MAX_COLS = 300;
const MIN_ROWS = 6;
const MAX_ROWS = 120;
const DEFAULT_COLS = 120;
const DEFAULT_ROWS = 28;

function clampInteger(value: unknown, min: number, max: number, fallback: number): number {
  const numberValue = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(numberValue)) return fallback;
  return Math.max(min, Math.min(max, Math.floor(numberValue)));
}

function parseClientMessage(raw: RawData, isBinary: boolean): TerminalClientMessage | null {
  if (isBinary) return null;
  try {
    const payload = JSON.parse(raw.toString("utf8")) as Partial<TerminalClientMessage>;
    if (!payload || typeof payload !== "object") return null;
    if (payload.type === "start" && typeof payload.terminalId === "string") return payload as TerminalClientMessage;
    if (payload.type === "input" && typeof payload.terminalId === "string" && typeof payload.data === "string") {
      return payload as TerminalClientMessage;
    }
    if (payload.type === "resize" && typeof payload.terminalId === "string") return payload as TerminalClientMessage;
    if (payload.type === "kill" && typeof payload.terminalId === "string") return payload as TerminalClientMessage;
    return null;
  } catch {
    return null;
  }
}

function send(socket: WebSocket, payload: unknown): void {
  if (socket.readyState !== WebSocket.OPEN) return;
  socket.send(JSON.stringify(payload));
}

function defaultShell(): { command: string; args: string[]; label: string } {
  if (process.env.OPENPOND_TERMINAL_SHELL) {
    const command = process.env.OPENPOND_TERMINAL_SHELL;
    return { command, args: interactiveShellArgs(command), label: path.basename(command) };
  }
  if (process.platform === "win32") {
    return { command: "powershell.exe", args: ["-NoLogo"], label: "PowerShell" };
  }
  const command = process.platform === "darwin" && existsSync("/bin/zsh") ? "/bin/zsh" : "/bin/bash";
  return { command, args: ["-i"], label: path.basename(command) || "bash" };
}

function terminalPath(): string {
  const entries = [
    path.join(process.env.HOME ?? "", ".local", "bin"),
    path.join(process.env.HOME ?? "", ".bun", "bin"),
    "/opt/homebrew/bin",
    "/usr/local/bin",
    "/usr/bin",
    "/bin",
    "/usr/sbin",
    "/sbin",
    process.env.PATH,
  ].filter(Boolean);
  return Array.from(new Set(entries.join(path.delimiter).split(path.delimiter).filter(Boolean))).join(path.delimiter);
}

function interactiveShellArgs(command: string): string[] {
  if (process.platform === "win32") return [];
  const name = path.basename(command);
  return name === "bash" || name === "zsh" || name === "fish" ? ["-i"] : [];
}

function safeCwd(input: unknown, fallback: string): string {
  if (typeof input !== "string" || !input.trim()) return fallback;
  const resolved = path.resolve(input);
  try {
    return statSync(resolved).isDirectory() ? resolved : fallback;
  } catch {
    return fallback;
  }
}

export function createTerminalWebSocketHandler(deps: {
  host: string;
  getActualPort: () => number;
  token: string;
  logger: TerminalLogger;
  defaultCwdForApp: (appId?: string | null) => string;
}): {
  handleUpgrade: (request: IncomingMessage, socket: Duplex, head: Buffer) => boolean;
  close: () => void;
} {
  const server = new WebSocketServer({
    noServer: true,
    perMessageDeflate: false,
    handleProtocols: (protocols) =>
      protocols.has(TERMINAL_WEBSOCKET_PROTOCOL) ? TERMINAL_WEBSOCKET_PROTOCOL : false,
  });
  const sockets = new Set<WebSocket>();
  const sessions = new Map<string, TerminalSession>();
  const socketTerminalIds = new Map<WebSocket, Set<string>>();

  function socketSessions(socket: WebSocket): Set<string> {
    const existing = socketTerminalIds.get(socket);
    if (existing) return existing;
    const next = new Set<string>();
    socketTerminalIds.set(socket, next);
    return next;
  }

  function appendOutputBuffer(session: TerminalSession, data: string): void {
    session.outputBuffer += data;
    if (session.outputBuffer.length > MAX_OUTPUT_BUFFER_CHARS) {
      session.outputBuffer = session.outputBuffer.slice(-MAX_OUTPUT_BUFFER_CHARS);
    }
  }

  function sendSessionOutput(session: TerminalSession, data: string): void {
    appendOutputBuffer(session, data);
    if (session.socket) send(session.socket, { type: "output", terminalId: session.id, data });
  }

  function removeSocketTerminal(socket: WebSocket, terminalId: string): void {
    const ids = socketTerminalIds.get(socket);
    ids?.delete(terminalId);
    if (ids?.size === 0) socketTerminalIds.delete(socket);
  }

  function closeSession(terminalId: string, reason = "closed"): void {
    const session = sessions.get(terminalId);
    if (!session) return;
    sessions.delete(terminalId);
    if (session.cleanupTimer) clearTimeout(session.cleanupTimer);
    if (session.socket) removeSocketTerminal(session.socket, terminalId);
    for (const disposable of session.disposables) disposable.dispose();
    session.disposables = [];
    try {
      session.pty.kill();
    } catch (error) {
      deps.logger.warn("terminal kill failed", { terminalId, reason, error });
    }
  }

  function scheduleSessionCleanup(session: TerminalSession): void {
    if (session.cleanupTimer) clearTimeout(session.cleanupTimer);
    session.cleanupTimer = setTimeout(() => {
      if (!session.socket) closeSession(session.id, "socket_closed");
    }, DISCONNECTED_SESSION_TTL_MS);
  }

  function detachSocketSessions(socket: WebSocket): void {
    const terminalIds = socketTerminalIds.get(socket);
    if (!terminalIds) return;
    socketTerminalIds.delete(socket);
    for (const terminalId of terminalIds) {
      const session = sessions.get(terminalId);
      if (!session || session.socket !== socket) continue;
      session.socket = null;
      scheduleSessionCleanup(session);
    }
  }

  function attachSession(socket: WebSocket, session: TerminalSession): void {
    if (session.cleanupTimer) {
      clearTimeout(session.cleanupTimer);
      session.cleanupTimer = null;
    }
    if (session.socket && session.socket !== socket) removeSocketTerminal(session.socket, session.id);
    session.socket = socket;
    socketSessions(socket).add(session.id);
    send(socket, {
      type: "ready",
      terminalId: session.id,
      pid: session.pid,
      cwd: session.cwd,
      shell: session.shell,
      cols: session.cols,
      rows: session.rows,
    });
    if (session.outputBuffer) send(socket, { type: "output", terminalId: session.id, data: session.outputBuffer });
  }

  function startSession(socket: WebSocket, message: Extract<TerminalClientMessage, { type: "start" }>): void {
    const existing = sessions.get(message.terminalId);
    if (existing) {
      existing.cols = clampInteger(message.cols, MIN_COLS, MAX_COLS, existing.cols);
      existing.rows = clampInteger(message.rows, MIN_ROWS, MAX_ROWS, existing.rows);
      existing.pty.resize(existing.cols, existing.rows);
      attachSession(socket, existing);
      return;
    }

    const cols = clampInteger(message.cols, MIN_COLS, MAX_COLS, DEFAULT_COLS);
    const rows = clampInteger(message.rows, MIN_ROWS, MAX_ROWS, DEFAULT_ROWS);
    const fallbackCwd = safeCwd(deps.defaultCwdForApp(message.appId ?? null), process.cwd());
    const cwd = safeCwd(message.cwd, fallbackCwd);
    const shell = defaultShell();

    try {
      const pty = spawnPty(shell.command, shell.args, {
        name: "xterm-256color",
        cols,
        rows,
        cwd,
        env: {
          ...process.env,
          COLORTERM: "truecolor",
          OPENPOND_TERMINAL: "1",
          PATH: terminalPath(),
          SHELL: process.platform === "win32" ? process.env.SHELL : shell.command,
          TERM: "xterm-256color",
        },
      });
      const session: TerminalSession = {
        id: message.terminalId,
        pty,
        disposables: [],
        socket,
        cleanupTimer: null,
        cwd,
        shell: shell.label,
        pid: pty.pid,
        cols,
        rows,
        outputBuffer: "",
      };
      session.disposables.push(
        pty.onData((data) => sendSessionOutput(session, data)),
        pty.onExit((exit) => {
          sessions.delete(message.terminalId);
          if (session.socket) removeSocketTerminal(session.socket, message.terminalId);
          if (session.cleanupTimer) clearTimeout(session.cleanupTimer);
          for (const disposable of session.disposables) disposable.dispose();
          session.disposables = [];
          if (session.socket) {
            send(session.socket, {
              type: "exit",
              terminalId: message.terminalId,
              code: exit.exitCode,
              signal: exit.signal ?? null,
            });
          }
          deps.logger.info("terminal exited", {
            terminalId: message.terminalId,
            pid: pty.pid,
            code: exit.exitCode,
            signal: exit.signal ?? null,
          });
        })
      );
      sessions.set(message.terminalId, session);
      socketSessions(socket).add(message.terminalId);
      attachSession(socket, session);
      deps.logger.info("terminal started", { terminalId: message.terminalId, pid: pty.pid, cwd, shell: shell.label });
    } catch (error) {
      const messageText = error instanceof Error ? error.message : String(error);
      deps.logger.error("terminal start failed", { terminalId: message.terminalId, cwd, shell: shell.label, error });
      send(socket, {
        type: "error",
        terminalId: message.terminalId,
        message: messageText,
      });
    }
  }

  function handleClientMessage(socket: WebSocket, message: TerminalClientMessage): void {
    if (message.type === "start") {
      startSession(socket, message);
      return;
    }
    const session = sessions.get(message.terminalId);
    if (!session) return;
    if (message.type === "input") {
      session.pty.write(message.data);
      return;
    }
    if (message.type === "resize") {
      const cols = clampInteger(message.cols, MIN_COLS, MAX_COLS, DEFAULT_COLS);
      const rows = clampInteger(message.rows, MIN_ROWS, MAX_ROWS, DEFAULT_ROWS);
      session.cols = cols;
      session.rows = rows;
      session.pty.resize(cols, rows);
      return;
    }
    if (message.type === "kill") closeSession(message.terminalId, "client_kill");
  }

  server.on("connection", (socket) => {
    sockets.add(socket);
    send(socket, { type: "hello" });
    socket.on("message", (raw, isBinary) => {
      const message = parseClientMessage(raw, isBinary);
      if (!message) {
        send(socket, { type: "error", terminalId: null, message: "Invalid terminal message" });
        return;
      }
      handleClientMessage(socket, message);
    });
    socket.on("close", () => {
      sockets.delete(socket);
      detachSocketSessions(socket);
    });
    socket.on("error", (error) => {
      deps.logger.warn("terminal socket error", { error });
      detachSocketSessions(socket);
    });
  });

  return {
    handleUpgrade: (request, socket, head) => {
      const requestUrl = new URL(request.url ?? "/", `http://${request.headers.host ?? `${deps.host}:${deps.getActualPort()}`}`);
      if (requestUrl.pathname !== "/v1/terminal") return false;
      if (!hasTerminalWebSocketAuth(request, requestUrl, deps.token)) {
        socket.write("HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n");
        socket.destroy();
        return true;
      }
      server.handleUpgrade(request, socket, head, (webSocket) => server.emit("connection", webSocket, request));
      return true;
    },
    close: () => {
      for (const socket of Array.from(sockets)) {
        detachSocketSessions(socket);
        socket.close();
      }
      for (const terminalId of Array.from(sessions.keys())) closeSession(terminalId, "server_closed");
      server.close();
    },
  };
}

export function hasTerminalWebSocketAuth(request: IncomingMessage, requestUrl: URL, token: string): boolean {
  return hasAuth(request, requestUrl, token) || terminalWebSocketProtocolToken(request) === token;
}

export function terminalWebSocketProtocolToken(request: IncomingMessage): string | null {
  const header = request.headers["sec-websocket-protocol"];
  const value = Array.isArray(header) ? header.join(",") : header;
  if (!value) return null;
  const encoded = value
    .split(",")
    .map((protocol) => protocol.trim())
    .find((protocol) => protocol.startsWith(TERMINAL_WEBSOCKET_TOKEN_PROTOCOL_PREFIX))
    ?.slice(TERMINAL_WEBSOCKET_TOKEN_PROTOCOL_PREFIX.length);
  return encoded ? base64UrlToText(encoded) : null;
}

function base64UrlToText(value: string): string {
  const base64 = value.replace(/-/g, "+").replace(/_/g, "/");
  const padded = base64.padEnd(Math.ceil(base64.length / 4) * 4, "=");
  return Buffer.from(padded, "base64").toString("utf8");
}
