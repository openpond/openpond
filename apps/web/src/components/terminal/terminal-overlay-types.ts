export type TerminalStatus = "connecting" | "running" | "exited" | "error";

export type TerminalTab = {
  id: string;
  title: string;
  cwd: string | null;
  appId: string | null;
  status: TerminalStatus;
  shell: string | null;
  detail: string | null;
};

export type TerminalClientMessage =
  | {
      type: "start";
      terminalId: string;
      cwd: string | null;
      appId: string | null;
      cols: number;
      rows: number;
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

export type TerminalServerMessage =
  | {
      type: "hello";
      home?: string;
    }
  | {
      type: "ready";
      terminalId: string;
      pid: number;
      cwd: string;
      shell: string;
      cols: number;
      rows: number;
    }
  | {
      type: "output";
      terminalId: string;
      data: string;
    }
  | {
      type: "exit";
      terminalId: string;
      code: number;
      signal: number | null;
    }
  | {
      type: "error";
      terminalId: string | null;
      message: string;
    };

export type TerminalHandle = {
  write: (data: string) => void;
  focus: () => void;
  fit: () => void;
  prepareForStart: () => { cols: number; rows: number };
};

export const DEFAULT_TERMINAL_COLS = 120;
export const DEFAULT_TERMINAL_ROWS = 28;
export const MOVE_CURSOR_TO_LAST_ROW = "\x1b[999;1H";

export function createTerminalId(): string {
  return typeof crypto !== "undefined" && "randomUUID" in crypto
    ? crypto.randomUUID()
    : `terminal-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

export function labelForCwd(cwd: string | null): string {
  if (!cwd) return "App workspace";
  const normalized = cwd.replace(/\\/g, "/").replace(/\/+$/, "");
  return normalized.split("/").filter(Boolean).at(-1) ?? cwd;
}

export function parseServerMessage(data: string): TerminalServerMessage | null {
  try {
    const payload = JSON.parse(data) as Partial<TerminalServerMessage>;
    if (!payload || typeof payload !== "object" || typeof payload.type !== "string") return null;
    return payload as TerminalServerMessage;
  } catch {
    return null;
  }
}

export function exitDetail(code: number, signal: number | null): string {
  if (signal === 1) return "Closed";
  if (signal) return `Closed by signal ${signal}`;
  return code === 0 ? "Closed" : `Exited ${code}`;
}
