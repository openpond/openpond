export const ESC = "\x1b[";

export type AnsiColor =
  | "reset"
  | "muted"
  | "text"
  | "strong"
  | "accent"
  | "success"
  | "warning"
  | "error"
  | "dim";

const COLORS: Record<AnsiColor, string> = {
  reset: "0",
  muted: "38;5;244",
  text: "38;5;252",
  strong: "38;5;255",
  accent: "38;5;81",
  success: "38;5;114",
  warning: "38;5;221",
  error: "38;5;203",
  dim: "38;5;240",
};

export function color(name: AnsiColor): string {
  return `${ESC}${COLORS[name]}m`;
}

export function style(text: string, name: AnsiColor): string {
  if (!text) return "";
  return `${color(name)}${text}${color("reset")}`;
}

export function surface(text: string): string {
  if (!text) return "";
  return `${ESC}48;5;236m${color("strong")}${text}${color("reset")}`;
}

export function surfaceLine(text: string, width: number, foreground: AnsiColor = "strong"): string {
  const padded = truncatePlain(text, Math.max(0, width)).padEnd(Math.max(0, width));
  return `${ESC}48;5;236m${color(foreground)}${padded}${color("reset")}`;
}

export function hideCursor(): string {
  return "\x1b[?25l";
}

export function showCursor(): string {
  return "\x1b[?25h";
}

export function setCursorColor(colorValue: string): string {
  return `\x1b]12;${colorValue}\x07`;
}

export function resetCursorColor(): string {
  return "\x1b]112\x07";
}

export function clearLine(): string {
  return `${ESC}2K`;
}

export function stripAnsi(input: string): string {
  return input.replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, "");
}

export function visibleLength(input: string): number {
  return Array.from(stripAnsi(input)).length;
}

export function truncatePlain(input: string, max: number): string {
  if (max <= 0) return "";
  const chars = Array.from(input);
  if (chars.length <= max) return input;
  if (max === 1) return ".";
  return `${chars.slice(0, max - 1).join("")}.`;
}
