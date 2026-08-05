export type MarkdownListItem = {
  content: string;
  checked: boolean | null;
  ordinal: number | null;
};

type MarkdownBlock =
  | { type: "paragraph"; content: string }
  | { type: "blockquote"; content: string }
  | { type: "code"; content: string; language?: string }
  | { type: "heading"; level: 1 | 2 | 3 | 4; content: string }
  | {
      type: "list";
      ordered: boolean;
      start: number | undefined;
      items: MarkdownListItem[];
    }
  | { type: "table"; headers: string[]; rows: string[][] };

export function parseBlocks(content: string): MarkdownBlock[] {
  const lines = content.replace(/\r\n/g, "\n").split("\n");
  const blocks: MarkdownBlock[] = [];
  let paragraph: string[] = [];
  let blockquoteLines: string[] = [];
  let listItems: MarkdownListItem[] = [];
  let listOrdered = false;
  let listStart: number | undefined;
  let codeLines: string[] | null = null;
  let codeLanguage: string | undefined;
  let codeFenceTicks = 0;

  function flushParagraph() {
    if (paragraph.length === 0) return;
    blocks.push({ type: "paragraph", content: paragraph.join("\n").trim() });
    paragraph = [];
  }

  function flushBlockquote() {
    if (blockquoteLines.length === 0) return;
    blocks.push({ type: "blockquote", content: blockquoteLines.join("\n") });
    blockquoteLines = [];
  }

  function flushList() {
    if (listItems.length === 0) return;
    blocks.push({
      type: "list",
      ordered: listOrdered,
      start: listStart,
      items: listItems,
    });
    listItems = [];
    listOrdered = false;
    listStart = undefined;
  }

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index]!;
    if (codeLines) {
      if (isClosingFenceLine(line, codeFenceTicks)) {
        blocks.push({ type: "code", content: codeLines.join("\n"), language: codeLanguage });
        codeLines = null;
        codeLanguage = undefined;
        codeFenceTicks = 0;
        continue;
      }
      codeLines.push(line);
      continue;
    }

    const blockquoteMatch = line.match(/^\s*>\s?(.*)$/);
    if (blockquoteMatch) {
      flushParagraph();
      flushList();
      blockquoteLines.push(blockquoteMatch[1] ?? "");
      continue;
    }
    flushBlockquote();

    const fence = parseOpeningFenceLine(line);
    if (fence) {
      flushParagraph();
      flushList();
      codeLines = fence.firstLine === undefined ? [] : [fence.firstLine];
      codeLanguage = fence.language;
      codeFenceTicks = fence.ticks;
      continue;
    }

    const table = parseTable(lines, index);
    if (table) {
      flushParagraph();
      flushList();
      blocks.push({ type: "table", headers: table.headers, rows: table.rows });
      index = table.endIndex;
      continue;
    }

    const headingMatch = line.match(/^\s*(#{1,4})(?:\s+|(?=\d+[.)]\s+))(.+)$/);
    if (headingMatch) {
      flushParagraph();
      flushList();
      const level = headingMatch[1]!.length as 1 | 2 | 3 | 4;
      blocks.push({ type: "heading", level, content: headingMatch[2]!.trim() });
      continue;
    }

    const listMatch = line.match(LIST_LINE_PATTERN);
    if (listMatch) {
      flushParagraph();
      const ordered = Boolean(listMatch[2]);
      if (listItems.length > 0 && ordered !== listOrdered) flushList();
      listOrdered = ordered;
      const ordinal = listMatch[2] ? Number(listMatch[2]) : null;
      if (listItems.length === 0) listStart = ordinal ?? undefined;
      listItems.push(parseListItem(listMatch[3]!.trim(), ordinal));
      continue;
    }

    if (!line.trim()) {
      flushParagraph();
      if (
        listItems.length > 0 &&
        nextListType(lines, index + 1) === listOrdered
      ) {
        continue;
      }
      flushList();
      continue;
    }

    flushList();
    paragraph.push(line);
  }

  if (codeLines) blocks.push({ type: "code", content: codeLines.join("\n"), language: codeLanguage });
  flushBlockquote();
  flushParagraph();
  flushList();
  return blocks;
}

const INCOMPLETE_BLOCK_MARKER_PATTERN =
  /^\s*(?:#{1,4}\s*|>\s*|\d+[.)]\s*|[-*]\s*)$/;

/** Avoids briefly rendering partial block syntax as prose during typewriter reveal. */
export function renderableStreamingMarkdown(
  content: string,
  complete: boolean
): string {
  if (complete) return content;
  const lineStart = content.lastIndexOf("\n") + 1;
  return INCOMPLETE_BLOCK_MARKER_PATTERN.test(content.slice(lineStart))
    ? content.slice(0, lineStart)
    : content;
}

function isClosingFenceLine(line: string, minTicks: number): boolean {
  const fence = line.match(/^\s*(`{2,})\s*(?:[A-Za-z0-9_-]+)?\s*$/);
  return Boolean(fence && fence[1]!.length >= minTicks);
}

function parseOpeningFenceLine(line: string): { language?: string; firstLine?: string; ticks: number } | null {
  const standardFence = line.match(/^\s*(`{2,})\s*([A-Za-z0-9_-]+)?\s*$/);
  if (standardFence) return { language: standardFence[2], ticks: standardFence[1]!.length };

  const runOnFence = line.match(/^\s*(`{2,})\s*([A-Za-z][A-Za-z0-9_-]*)(?:\s+(\S.*)|(\S.*))$/);
  if (!runOnFence) return null;
  return {
    language: runOnFence[2],
    firstLine: runOnFence[3] ?? runOnFence[4],
    ticks: runOnFence[1]!.length,
  };
}

const LIST_LINE_PATTERN = /^\s*(?:([-*])|(\d+)[.)])\s+(.+)$/;

function nextListType(lines: string[], startIndex: number): boolean | null {
  let index = startIndex;
  while (index < lines.length && !lines[index]!.trim()) index += 1;
  const match = (lines[index] ?? "").match(LIST_LINE_PATTERN);
  return match ? Boolean(match[2]) : null;
}

function parseListItem(
  value: string,
  ordinal: number | null
): MarkdownListItem {
  const taskMatch = /^\[([ xX])]\s*(.*)$/.exec(value);
  if (!taskMatch) return { content: value, checked: null, ordinal };
  return {
    content: taskMatch[2] ?? "",
    checked: taskMatch[1]?.toLowerCase() === "x",
    ordinal,
  };
}

function parseTable(lines: string[], startIndex: number): { headers: string[]; rows: string[][]; endIndex: number } | null {
  const headerLine = lines[startIndex] ?? "";
  const separatorLine = lines[startIndex + 1] ?? "";
  if (!headerLine.includes("|") || !isTableSeparator(separatorLine)) return null;
  const headers = splitTableRow(headerLine);
  if (headers.length === 0) return null;
  const rows: string[][] = [];
  let index = startIndex + 2;
  while (index < lines.length) {
    const line = lines[index] ?? "";
    if (!line.trim() || !line.includes("|")) break;
    rows.push(splitTableRow(line));
    index += 1;
  }
  return { headers, rows, endIndex: index - 1 };
}

function isTableSeparator(line: string): boolean {
  const cells = splitTableRow(line);
  return cells.length > 0 && cells.every((cell) => /^:?-{3,}:?$/.test(cell.trim()));
}

function splitTableRow(line: string): string[] {
  const trimmed = line.trim().replace(/^\|/, "").replace(/\|$/, "");
  return trimmed.split("|").map((cell) => cell.trim());
}
