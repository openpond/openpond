import { Buffer } from "node:buffer";
import { existsSync, mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { Duplex } from "node:stream";
import type { IncomingMessage } from "node:http";
import type { IPty, IDisposable } from "node-pty";
import { spawn as spawnPty } from "node-pty";
import { WebSocket, WebSocketServer, type RawData } from "ws";
import { TerminalScopeSchema, type TerminalScope } from "@openpond/contracts";
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
      scope: TerminalScope;
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
  scope: TerminalScope;
  pty: IPty;
  disposables: IDisposable[];
  socket: WebSocket | null;
  cleanupTimer: NodeJS.Timeout | null;
  integrationDir: string | null;
  integrationPending: string;
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
const OPENPOND_TERMINAL_MARKER_START = "\x1b]1337;OpenPond;";
const OPENPOND_TERMINAL_MARKER_END = "\x07";
const MAX_INTEGRATION_PENDING_CHARS = 4096;

export type TerminalIntegrationEvent =
  | { type: "command_start"; command: string | null; sequence: number }
  | { type: "command_end"; exitCode: number; sequence: number }
  | { type: "prompt_ready"; sequence: number };

function clampInteger(value: unknown, min: number, max: number, fallback: number): number {
  const numberValue = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(numberValue)) return fallback;
  return Math.max(min, Math.min(max, Math.floor(numberValue)));
}

export function parseClientMessage(raw: RawData, isBinary: boolean): TerminalClientMessage | null {
  if (isBinary) return null;
  try {
    const payload = JSON.parse(raw.toString("utf8")) as Partial<TerminalClientMessage>;
    if (!payload || typeof payload !== "object") return null;
    if (payload.type === "start" && typeof payload.terminalId === "string") {
      const scope = TerminalScopeSchema.safeParse(payload.scope);
      if (!scope.success) return null;
      return { ...payload, scope: scope.data } as TerminalClientMessage;
    }
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

function defaultShell(): { command: string; args: string[]; label: string; env?: Record<string, string>; integrationDir?: string | null } {
  if (process.env.OPENPOND_TERMINAL_SHELL) {
    const command = process.env.OPENPOND_TERMINAL_SHELL;
    return shellLaunch(command, interactiveShellArgs(command), path.basename(command));
  }
  if (process.platform === "win32") {
    return { command: "powershell.exe", args: ["-NoLogo"], label: "PowerShell" };
  }
  const command = process.platform === "darwin" && existsSync("/bin/zsh") ? "/bin/zsh" : "/bin/bash";
  return shellLaunch(command, ["-i"], path.basename(command) || "bash");
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

function terminalScopesEqual(left: TerminalScope, right: TerminalScope): boolean {
  return left.kind === right.kind && left.id === right.id;
}

export function terminalScopesCompatibleForAttach(existing: TerminalScope, requested: TerminalScope): boolean {
  return terminalScopesEqual(existing, requested) || (existing.kind === "draft" && requested.kind === "session");
}

function terminalScopeLogValue(scope: TerminalScope): string {
  return `${scope.kind}:${scope.id}`;
}

function shellLaunch(
  command: string,
  fallbackArgs: string[],
  label: string,
): { command: string; args: string[]; label: string; env?: Record<string, string>; integrationDir?: string | null } {
  if (process.platform === "win32") return { command, args: fallbackArgs, label, integrationDir: null };
  const name = path.basename(command);
  if (name === "bash") return bashShellLaunch(command, label);
  if (name === "zsh") return zshShellLaunch(command, label);
  if (name === "fish") return fishShellLaunch(command, label);
  return { command, args: fallbackArgs, label, integrationDir: null };
}

function createShellIntegrationDir(): string {
  return mkdtempSync(path.join(os.tmpdir(), "openpond-terminal-"));
}

function removeShellIntegrationDir(dir: string | null): void {
  if (!dir) return;
  try {
    rmSync(dir, { recursive: true, force: true });
  } catch {
    // Best-effort cleanup only. These files contain no credentials.
  }
}

function bashShellLaunch(command: string, label: string) {
  const integrationDir = createShellIntegrationDir();
  const rcFile = path.join(integrationDir, "openpond.bashrc");
  writeFileSync(rcFile, bashIntegrationScript(), "utf8");
  return {
    command,
    args: ["--rcfile", rcFile, "-i"],
    label,
    env: {
      OPENPOND_ORIGINAL_BASHRC: path.join(process.env.HOME ?? "", ".bashrc"),
    },
    integrationDir,
  };
}

function zshShellLaunch(command: string, label: string) {
  const integrationDir = createShellIntegrationDir();
  writeFileSync(path.join(integrationDir, ".zshenv"), zshEnvScript(), "utf8");
  writeFileSync(path.join(integrationDir, ".zshrc"), zshIntegrationScript(), "utf8");
  return {
    command,
    args: ["-i"],
    label,
    env: {
      ZDOTDIR: integrationDir,
      OPENPOND_ORIGINAL_ZDOTDIR: process.env.ZDOTDIR ?? process.env.HOME ?? "",
    },
    integrationDir,
  };
}

function fishShellLaunch(command: string, label: string) {
  const integrationDir = createShellIntegrationDir();
  const scriptPath = path.join(integrationDir, "openpond.fish");
  writeFileSync(scriptPath, fishIntegrationScript(), "utf8");
  return {
    command,
    args: ["-i", "--init-command", `source ${shellQuote(scriptPath)}`],
    label,
    integrationDir,
  };
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, "'\\''")}'`;
}

function bashIntegrationScript(): string {
  const parameter = "$";
  return String.raw`if [ -n "${parameter}{OPENPOND_ORIGINAL_BASHRC:-}" ] && [ -r "$OPENPOND_ORIGINAL_BASHRC" ]; then
  . "$OPENPOND_ORIGINAL_BASHRC"
fi

__openpond_seq=0
__openpond_command_running=0
__openpond_in_prompt=0

__openpond_b64() {
  printf "%s" "$1" | base64 | tr '+/' '-_' | tr -d '=\n'
}

__openpond_marker() {
  printf '\033]1337;OpenPond;%s;sequence=%s%s\007' "$1" "$2" "$3"
}

__openpond_debug_trap() {
  local status=$?
  if [ "${parameter}{__openpond_in_prompt:-0}" = "1" ]; then return "$status"; fi
  if [ "${parameter}{__openpond_command_running:-0}" = "1" ]; then return "$status"; fi
  case "$BASH_COMMAND" in
    __openpond_*|trap\ *|PROMPT_COMMAND=*|return\ *|local\ *) return "$status" ;;
  esac
  __openpond_seq=$((__openpond_seq + 1))
  __openpond_command_running=1
  __openpond_marker "command_start" "$__openpond_seq" ";command=$(__openpond_b64 "$BASH_COMMAND")"
  return "$status"
}

__openpond_prompt_start() {
  local exit_code=$?
  __openpond_in_prompt=1
  if [ "${parameter}{__openpond_command_running:-0}" = "1" ]; then
    __openpond_seq=$((__openpond_seq + 1))
    __openpond_marker "command_end" "$__openpond_seq" ";exitCode=$exit_code"
    __openpond_command_running=0
  fi
  return "$exit_code"
}

__openpond_prompt_finish() {
  local prompt_status=$?
  __openpond_seq=$((__openpond_seq + 1))
  __openpond_marker "prompt_ready" "$__openpond_seq" ""
  __openpond_in_prompt=0
  return "$prompt_status"
}

if declare -p PROMPT_COMMAND 2>/dev/null | grep -q '^declare \-[^ ]*a'; then
  PROMPT_COMMAND=(__openpond_prompt_start "${parameter}{PROMPT_COMMAND[@]}" __openpond_prompt_finish)
elif [ -n "${parameter}{PROMPT_COMMAND:-}" ]; then
  PROMPT_COMMAND="__openpond_prompt_start
${parameter}{PROMPT_COMMAND}
__openpond_prompt_finish"
else
  PROMPT_COMMAND="__openpond_prompt_start
__openpond_prompt_finish"
fi

if [ -z "$(trap -p DEBUG)" ]; then
  trap '__openpond_debug_trap' DEBUG
fi
`;
}

function zshEnvScript(): string {
  const parameter = "$";
  return String.raw`if [[ -n "${parameter}{OPENPOND_ORIGINAL_ZDOTDIR:-}" && -r "${parameter}{OPENPOND_ORIGINAL_ZDOTDIR}/.zshenv" ]]; then
  source "${parameter}{OPENPOND_ORIGINAL_ZDOTDIR}/.zshenv"
fi
`;
}

function zshIntegrationScript(): string {
  const parameter = "$";
  return String.raw`if [[ -n "${parameter}{OPENPOND_ORIGINAL_ZDOTDIR:-}" && -r "${parameter}{OPENPOND_ORIGINAL_ZDOTDIR}/.zshrc" ]]; then
  source "${parameter}{OPENPOND_ORIGINAL_ZDOTDIR}/.zshrc"
fi

autoload -Uz add-zsh-hook
typeset -g __openpond_seq=0
typeset -g __openpond_command_running=0

__openpond_b64() {
  printf "%s" "$1" | base64 | tr '+/' '-_' | tr -d '=\n'
}

__openpond_marker() {
  printf '\033]1337;OpenPond;%s;sequence=%s%s\007' "$1" "$2" "$3"
}

__openpond_preexec() {
  __openpond_seq=$((__openpond_seq + 1))
  __openpond_command_running=1
  __openpond_marker "command_start" "$__openpond_seq" ";command=$(__openpond_b64 "$1")"
}

__openpond_precmd() {
  local exit_code=$?
  if [[ "$__openpond_command_running" == "1" ]]; then
    __openpond_seq=$((__openpond_seq + 1))
    __openpond_marker "command_end" "$__openpond_seq" ";exitCode=$exit_code"
    __openpond_command_running=0
  fi
  __openpond_seq=$((__openpond_seq + 1))
  __openpond_marker "prompt_ready" "$__openpond_seq" ""
}

add-zsh-hook preexec __openpond_preexec
add-zsh-hook precmd __openpond_precmd
`;
}

function fishIntegrationScript(): string {
  return String.raw`set -g __openpond_seq 0
set -g __openpond_command_running 0

function __openpond_b64
  printf "%s" "$argv" | base64 | tr '+/' '-_' | tr -d '=\n'
end

function __openpond_marker
  printf '\e]1337;OpenPond;%s;sequence=%s%s\a' "$argv[1]" "$argv[2]" "$argv[3]"
end

function __openpond_preexec --on-event fish_preexec
  set -g __openpond_seq (math $__openpond_seq + 1)
  set -g __openpond_command_running 1
  __openpond_marker command_start $__openpond_seq ";command="(__openpond_b64 "$argv")
end

function __openpond_postexec --on-event fish_postexec
  set exit_code $status
  if test "$__openpond_command_running" = "1"
    set -g __openpond_seq (math $__openpond_seq + 1)
    __openpond_marker command_end $__openpond_seq ";exitCode=$exit_code"
    set -g __openpond_command_running 0
  end
  set -g __openpond_seq (math $__openpond_seq + 1)
  __openpond_marker prompt_ready $__openpond_seq ""
end
`;
}

export function parseTerminalIntegrationOutput(input: string): {
  output: string;
  pending: string;
  events: TerminalIntegrationEvent[];
} {
  let output = "";
  let pending = "";
  let cursor = 0;
  const events: TerminalIntegrationEvent[] = [];

  while (cursor < input.length) {
    const markerStart = input.indexOf(OPENPOND_TERMINAL_MARKER_START, cursor);
    if (markerStart === -1) {
      output += input.slice(cursor);
      break;
    }
    output += input.slice(cursor, markerStart);
    const payloadStart = markerStart + OPENPOND_TERMINAL_MARKER_START.length;
    const markerEnd = input.indexOf(OPENPOND_TERMINAL_MARKER_END, payloadStart);
    if (markerEnd === -1) {
      pending = input.slice(markerStart);
      if (pending.length > MAX_INTEGRATION_PENDING_CHARS) {
        output += pending;
        pending = "";
      }
      break;
    }
    const event = parseTerminalIntegrationMarker(input.slice(payloadStart, markerEnd));
    if (event) events.push(event);
    cursor = markerEnd + OPENPOND_TERMINAL_MARKER_END.length;
  }

  return { output, pending, events };
}

function parseTerminalIntegrationMarker(marker: string): TerminalIntegrationEvent | null {
  const [kind, ...fields] = marker.split(";");
  const values = new Map<string, string>();
  for (const field of fields) {
    const separator = field.indexOf("=");
    if (separator <= 0) continue;
    values.set(field.slice(0, separator), field.slice(separator + 1));
  }
  const sequence = Number(values.get("sequence"));
  if (!Number.isSafeInteger(sequence) || sequence < 0) return null;
  if (kind === "command_start") {
    const command = values.get("command");
    return { type: "command_start", sequence, command: command ? base64UrlToText(command) : null };
  }
  if (kind === "command_end") {
    const exitCode = Number(values.get("exitCode"));
    if (!Number.isSafeInteger(exitCode)) return null;
    return { type: "command_end", sequence, exitCode };
  }
  if (kind === "prompt_ready") return { type: "prompt_ready", sequence };
  return null;
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

  function sendIntegrationEvent(session: TerminalSession, event: TerminalIntegrationEvent): void {
    if (!session.socket) return;
    send(session.socket, { ...event, terminalId: session.id });
  }

  function handleSessionData(session: TerminalSession, data: string): void {
    const parsed = parseTerminalIntegrationOutput(session.integrationPending + data);
    session.integrationPending = parsed.pending;
    if (parsed.output) sendSessionOutput(session, parsed.output);
    for (const event of parsed.events) sendIntegrationEvent(session, event);
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
    removeShellIntegrationDir(session.integrationDir);
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
      scope: session.scope,
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
      if (!terminalScopesCompatibleForAttach(existing.scope, message.scope)) {
        send(socket, {
          type: "error",
          terminalId: message.terminalId,
          message: "Terminal belongs to a different conversation or project.",
        });
        deps.logger.warn("terminal scope mismatch", {
          terminalId: message.terminalId,
          existingScope: terminalScopeLogValue(existing.scope),
          requestedScope: terminalScopeLogValue(message.scope),
        });
        return;
      }
      if (!terminalScopesEqual(existing.scope, message.scope)) {
        if (existing.scope.kind === "draft" && message.scope.kind === "session") {
          existing.scope = message.scope;
        }
      }
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
          ...shell.env,
        },
      });
      const session: TerminalSession = {
        id: message.terminalId,
        scope: message.scope,
        pty,
        disposables: [],
        socket,
        cleanupTimer: null,
        integrationDir: shell.integrationDir ?? null,
        integrationPending: "",
        cwd,
        shell: shell.label,
        pid: pty.pid,
        cols,
        rows,
        outputBuffer: "",
      };
      session.disposables.push(
        pty.onData((data) => handleSessionData(session, data)),
        pty.onExit((exit) => {
          sessions.delete(message.terminalId);
          if (session.socket) removeSocketTerminal(session.socket, message.terminalId);
          if (session.cleanupTimer) clearTimeout(session.cleanupTimer);
          for (const disposable of session.disposables) disposable.dispose();
          session.disposables = [];
          removeShellIntegrationDir(session.integrationDir);
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
            scope: terminalScopeLogValue(session.scope),
            pid: pty.pid,
            code: exit.exitCode,
            signal: exit.signal ?? null,
          });
        })
      );
      sessions.set(message.terminalId, session);
      socketSessions(socket).add(message.terminalId);
      attachSession(socket, session);
      deps.logger.info("terminal started", {
        terminalId: message.terminalId,
        scope: terminalScopeLogValue(message.scope),
        pid: pty.pid,
        cwd,
        shell: shell.label,
      });
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
