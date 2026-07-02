export type MarkdownListItem = {
  content: string;
  checked: boolean | null;
};

type MarkdownBlock =
  | { type: "paragraph"; content: string }
  | { type: "code"; content: string; language?: string }
  | { type: "heading"; level: 1 | 2 | 3 | 4; content: string }
  | { type: "list"; ordered: boolean; items: MarkdownListItem[] }
  | { type: "table"; headers: string[]; rows: string[][] };

export function parseBlocks(content: string): MarkdownBlock[] {
  const lines = content.replace(/\r\n/g, "\n").split("\n");
  const blocks: MarkdownBlock[] = [];
  let paragraph: string[] = [];
  let listItems: MarkdownListItem[] = [];
  let listOrdered = false;
  let codeLines: string[] | null = null;
  let codeLanguage: string | undefined;

  function flushParagraph() {
    if (paragraph.length === 0) return;
    blocks.push({ type: "paragraph", content: paragraph.join("\n").trim() });
    paragraph = [];
  }

  function flushList() {
    if (listItems.length === 0) return;
    blocks.push({ type: "list", ordered: listOrdered, items: listItems });
    listItems = [];
    listOrdered = false;
  }

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index]!;
    const fence = line.match(/^```\s*([A-Za-z0-9_-]+)?\s*$/);
    if (fence) {
      if (codeLines) {
        blocks.push({ type: "code", content: codeLines.join("\n"), language: codeLanguage });
        codeLines = null;
        codeLanguage = undefined;
      } else {
        flushParagraph();
        flushList();
        codeLines = [];
        codeLanguage = fence[1];
      }
      continue;
    }

    if (codeLines) {
      codeLines.push(line);
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

    const headingMatch = line.match(/^\s*#{1,4}\s+(.+)$/);
    if (headingMatch) {
      flushParagraph();
      flushList();
      const level = Math.min(4, Math.max(1, line.trimStart().indexOf(" "))) as 1 | 2 | 3 | 4;
      blocks.push({ type: "heading", level, content: headingMatch[1]!.trim() });
      continue;
    }

    const listMatch = line.match(/^\s*(?:([-*])|(\d+)[.)])\s+(.+)$/);
    if (listMatch) {
      flushParagraph();
      const ordered = Boolean(listMatch[2]);
      if (listItems.length > 0 && ordered !== listOrdered) flushList();
      listOrdered = ordered;
      listItems.push(parseListItem(listMatch[3]!.trim()));
      continue;
    }

    if (!line.trim()) {
      flushParagraph();
      flushList();
      continue;
    }

    flushList();
    paragraph.push(line);
  }

  if (codeLines) blocks.push({ type: "code", content: codeLines.join("\n"), language: codeLanguage });
  flushParagraph();
  flushList();
  return blocks;
}

function parseListItem(value: string): MarkdownListItem {
  const taskMatch = /^\[([ xX])]\s*(.*)$/.exec(value);
  if (!taskMatch) return { content: value, checked: null };
  return {
    content: taskMatch[2] ?? "",
    checked: taskMatch[1]?.toLowerCase() === "x",
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
