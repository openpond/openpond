import { style, surfaceLine, truncatePlain } from "./ansi.js";
import type { ComposerState } from "./composer.js";
import type { SlashCommandDefinition } from "./commands.js";
import type { TranscriptItem } from "./transcript.js";

export type TerminalStatus = {
  provider: string;
  model: string;
  cwd: string;
  profile: string;
  agent: string | null;
  running: boolean;
  sessionId: string | null;
  notice: string | null;
};

export type LayoutInput = {
  cols: number;
  rows: number;
  transcript: TranscriptItem[];
  composer: ComposerState;
  slashMenu: SlashMenuLayout | null;
  status: TerminalStatus;
  scrollOffset: number;
};

export type SlashMenuLayout = {
  items: SlashCommandDefinition[];
  selectedIndex: number;
};

export type LayoutFrame = {
  lines: string[];
  cursorRow: number;
  cursorCol: number;
};

type ComposerLayout = {
  lines: string[];
  cursorLine: number;
  cursorCol: number;
};

export function buildFrame(input: LayoutInput): LayoutFrame {
  const cols = Math.max(20, input.cols);
  const rows = Math.max(4, input.rows);
  const composer = renderComposer(input.composer, cols, Math.min(5, rows - 1));
  const menuRows = renderSlashMenu(input.slashMenu, cols, Math.max(0, rows - composer.lines.length - 1));
  const footer = renderFooter(input.status, cols);
  const fixedRows = 1 + composer.lines.length + menuRows.length;
  const transcriptRows = Math.max(0, rows - fixedRows);
  const transcriptLines = renderTranscript(input.transcript, cols);
  const start = Math.max(0, transcriptLines.length - transcriptRows - input.scrollOffset);
  const visibleTranscript =
    transcriptLines.length > 0
      ? transcriptLines.slice(start, start + transcriptRows)
      : input.status.running
        ? [style("Working...", "muted")]
        : [];
  const spacer = visibleTranscript.length > 0 ? ["", ""] : [];
  const lines = [...visibleTranscript, ...spacer, ...composer.lines, ...menuRows, footer].slice(0, rows);
  const composerStartRow = visibleTranscript.length + spacer.length + 1;
  return {
    lines,
    cursorRow: Math.min(lines.length, composerStartRow + composer.cursorLine),
    cursorCol: Math.min(cols, composer.cursorCol),
  };
}

function renderFooter(status: TerminalStatus, cols: number): string {
  const left = `${status.provider || "OpenPond"} / ${status.model || "OpenPond Chat"}  ${compactPath(status.cwd)}`;
  const right = status.notice ?? (status.running ? "running" : "/help");
  const gap = Math.max(1, cols - visible(left) - visible(right));
  return style(truncatePlain(`${left}${" ".repeat(gap)}${right}`, cols), "muted");
}

function renderTranscript(items: TranscriptItem[], cols: number): string[] {
  const lines: string[] = [];
  for (const item of items) {
    if (lines.length > 0) lines.push("");
    lines.push(...renderItem(item, cols));
  }
  return lines;
}

export function renderTranscriptItemsForScrollback(items: TranscriptItem[], cols: number): string[] {
  return renderTranscript(items, cols);
}

export function renderWelcome(status: TerminalStatus, cols: number): string[] {
  const profile = status.profile || "none";
  const agent = status.agent ? `  agent: ${status.agent}` : "";
  const rows = [
    "OpenPond",
    `provider: ${status.provider || "OpenPond"}  /provider`,
    `model: ${status.model || "OpenPond Chat"}  /model`,
    `directory: ${compactPath(status.cwd)}`,
    `profile: ${profile}${agent}`,
  ];
  const width = Math.min(cols, Math.max(34, ...rows.map((row) => visible(row) + 4)));
  const horizontal = "─".repeat(Math.max(0, width - 2));
  return [
    style(`┌${horizontal}┐`, "accent"),
    ...rows.map((row, index) => {
      const padded = row.padEnd(Math.max(0, width - 4));
      return `${style("│", "accent")} ${style(padded, index === 0 ? "strong" : "text")} ${style("│", "accent")}`;
    }),
    style(`└${horizontal}┘`, "accent"),
  ];
}

function renderItem(item: TranscriptItem, cols: number): string[] {
  if (item.kind === "user") return renderUserMessage(item.text, cols);
  if (item.kind === "assistant") return renderAssistantMessage(item.text || (item.streaming ? "..." : ""), cols);
  if (item.kind === "system") return renderBlock("!", item.text, cols, item.tone === "error" ? "error" : item.tone === "warning" ? "warning" : "muted", "muted");
  if (item.kind === "approval") {
    const body = `${item.title}${item.body ? `\n${item.body}` : ""}`;
    return renderBlock("?", body, cols, "warning", "text");
  }
  if (item.kind === "command") {
    const output = compactOutput(item.output);
    const body = output ? `${item.title}\n${output}` : item.title;
    return renderBlock(item.status === "failed" ? "!" : "$", body, cols, item.status === "failed" ? "error" : "warning", "text");
  }
  const summary = compactOutput(item.summary);
  const body = summary ? `${item.title}\n${summary}` : item.title;
  const label = item.status === "failed" ? "!" : item.status === "running" ? "*" : "ok";
  return renderBlock(label, body, cols, item.status === "failed" ? "error" : item.status === "running" ? "warning" : "success", "text");
}

function renderUserMessage(body: string, cols: number): string[] {
  const bodyWidth = Math.max(12, cols - 4);
  const bodyLines = body
    .split(/\r?\n/)
    .flatMap((line) => wrapPlain(line, bodyWidth));
  return [
    surfaceLine("", cols),
    ...bodyLines.map((line) => surfaceLine(`  ${line}`, cols)),
    surfaceLine("", cols),
    "",
    "",
  ];
}

function renderSlashMenu(menu: SlashMenuLayout | null, cols: number, maxRows: number): string[] {
  if (!menu || menu.items.length === 0 || maxRows <= 0) return [];
  const visibleRows = Math.min(maxRows, 8, menu.items.length);
  const selected = clamp(menu.selectedIndex, 0, menu.items.length - 1);
  const start = Math.min(Math.max(0, selected - Math.floor(visibleRows / 2)), Math.max(0, menu.items.length - visibleRows));
  const visibleItems = menu.items.slice(start, start + visibleRows);
  const usageWidth = Math.min(24, Math.max(...visibleItems.map((item) => item.usage.length)));
  return visibleItems.map((item, offset) => {
    const index = start + offset;
    const usage = item.usage.padEnd(usageWidth);
    return surfaceLine(`   ${usage}  ${item.description}`, cols, index === selected ? "accent" : "text");
  });
}

function renderAssistantMessage(body: string, cols: number): string[] {
  const lines = body
    .split(/\r?\n/)
    .flatMap((line) => wrapPlain(line, Math.max(8, cols)))
    .map((line) => style(line, "text"));
  return [...lines, ""];
}

function renderBlock(label: string, body: string, cols: number, labelColor: Parameters<typeof style>[1], bodyColor: Parameters<typeof style>[1]): string[] {
  const labelWidth = Math.min(9, Math.max(2, label.length));
  const bodyWidth = Math.max(8, cols - labelWidth - 2);
  const bodyLines = body.split(/\r?\n/).flatMap((line) => wrapPlain(line, bodyWidth));
  const first = bodyLines[0] ?? "";
  const lines = [`${style(label.padEnd(labelWidth), labelColor)}  ${style(first, bodyColor)}`];
  for (const line of bodyLines.slice(1)) {
    lines.push(`${" ".repeat(labelWidth)}  ${style(line, bodyColor)}`);
  }
  return lines;
}

function compactPath(cwd: string): string {
  const normalized = cwd.replace(/\\/g, "/");
  const home = process.env.HOME?.replace(/\\/g, "/");
  if (home && normalized === home) return "~";
  if (home && normalized.startsWith(`${home}/`)) return `~/${normalized.slice(home.length + 1)}`;
  return normalized;
}

function compactOutput(output: string): string {
  const trimmed = output.trim();
  if (!trimmed) return "";
  const lines = trimmed.split(/\r?\n/);
  const maxLines = 8;
  const clipped = lines.length > maxLines ? [...lines.slice(0, maxLines - 1), `... ${lines.length - maxLines + 1} more lines`] : lines;
  return clipped.map((line) => truncatePlain(line, 160)).join("\n");
}

function renderComposer(composer: ComposerState, cols: number, maxLines: number): ComposerLayout {
  const width = Math.max(1, cols - 4);
  const wrapped = wrapComposerText(composer.text, composer.cursor, width);
  const maxTextLines = Math.max(1, maxLines - 2);
  const start = Math.max(0, wrapped.cursorLine - maxTextLines + 1);
  const visibleLines = wrapped.lines.slice(start, start + maxLines);
  const renderedText = visibleLines.slice(0, maxTextLines).map((line) => {
    const text = line || (composer.text ? "" : " message OpenPond or /help");
    return surfaceLine(`  ${text}`, cols, line ? "strong" : "dim");
  });
  if (renderedText.length === 0) renderedText.push(surfaceLine("   message OpenPond or /help", cols, "dim"));
  const cursorLine = Math.max(0, wrapped.cursorLine - start);
  return {
    lines: [surfaceLine("", cols), ...renderedText, surfaceLine("", cols)],
    cursorLine: cursorLine + 1,
    cursorCol: 3 + wrapped.cursorCol,
  };
}

function wrapComposerText(text: string, cursor: number, width: number): { lines: string[]; cursorLine: number; cursorCol: number } {
  const lines = [""];
  let line = 0;
  let col = 0;
  let cursorLine = 0;
  let cursorCol = 0;
  const chars = Array.from(text);
  for (let i = 0; i <= chars.length; i += 1) {
    if (i === cursor) {
      cursorLine = line;
      cursorCol = col;
    }
    if (i === chars.length) break;
    const char = chars[i]!;
    if (char === "\n" || col >= width) {
      line += 1;
      col = 0;
      lines[line] = "";
      if (char === "\n") continue;
    }
    lines[line] += char;
    col += 1;
  }
  return { lines, cursorLine, cursorCol };
}

function wrapPlain(input: string, width: number): string[] {
  if (!input) return [""];
  const words = input.split(/(\s+)/);
  const lines: string[] = [];
  let current = "";
  for (const word of words) {
    if (!word) continue;
    if (visible(current) + visible(word) <= width) {
      current += word;
      continue;
    }
    if (current.trimEnd()) lines.push(current.trimEnd());
    current = "";
    if (visible(word) > width) {
      const chars = Array.from(word);
      while (chars.length > width) lines.push(chars.splice(0, width).join(""));
      current = chars.join("");
    } else {
      current = word.trimStart();
    }
  }
  if (current.trimEnd()) lines.push(current.trimEnd());
  return lines.length ? lines : [""];
}

function visible(input: string): number {
  return Array.from(input).length;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}
