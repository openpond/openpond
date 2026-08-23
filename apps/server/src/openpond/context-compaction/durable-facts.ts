import type {
  CompactionDurableFact,
  CompactionDurableFactKind,
} from "./types.js";

const MAX_DURABLE_FACTS_PER_RECORD = 32;
const MAX_FACT_LABEL_CHARS = 96;
const MAX_FACT_VALUE_CHARS = 180;

const LABELED_FACT_PATTERN = /\b((?:[A-Za-z][A-Za-z0-9_-]*[ \t]+){0,7}(?:action|branch|code|color|command|commit|database|endpoint|error|file|hash|id|identifier|model|path|port|project|provider|region|revision|status|token|url|version|workspace))\s+(?:is|=|:)\s+([^\n.!?;]{1,180})/gi;
const ERROR_CODE_PATTERN = /\b[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)+\b/g;
const BRANCH_PATTERN = /\b(?:chore|feat|feature|fix|hotfix|refactor|release|test)\/[A-Za-z0-9._/-]+\b/g;
const COMMAND_PATTERN = /\b(?:bun|cargo|go|npm|npx|pnpm|pytest|uv|yarn)\s+[^\n.;]{1,160}/gi;

export function extractCompactionDurableFacts(input: {
  text: string;
  filePaths?: readonly string[];
  action?: string | null;
}): CompactionDurableFact[] {
  const facts: CompactionDurableFact[] = [];
  const seen = new Set<string>();

  function add(kind: CompactionDurableFactKind, label: string, value: string): void {
    if (facts.length >= MAX_DURABLE_FACTS_PER_RECORD) return;
    const normalizedLabel = clean(label, MAX_FACT_LABEL_CHARS);
    const normalizedValue = clean(value, MAX_FACT_VALUE_CHARS);
    if (!normalizedLabel || !normalizedValue) return;
    const key = `${kind}:${normalizedValue.toLowerCase()}`;
    if (seen.has(key)) return;
    seen.add(key);
    facts.push({ kind, label: normalizedLabel, value: normalizedValue });
  }

  for (const path of input.filePaths ?? []) add("path", "path", path);

  for (const match of input.text.matchAll(LABELED_FACT_PATTERN)) {
    const label = match[1] ?? "value";
    const value = match[2] ?? "";
    add(kindForLabel(label), label, value);
  }
  for (const match of input.text.matchAll(ERROR_CODE_PATTERN)) {
    add("error_code", "error code", match[0]);
  }
  for (const match of input.text.matchAll(BRANCH_PATTERN)) {
    add("branch", "branch", match[0]);
  }
  for (const match of input.text.matchAll(COMMAND_PATTERN)) {
    add("command", "command", match[0]);
  }
  if (input.action && isCommand(input.action)) add("command", "action", input.action);

  return facts;
}

function kindForLabel(label: string): CompactionDurableFactKind {
  const normalized = label.toLowerCase();
  if (normalized.includes("branch")) return "branch";
  if (normalized.includes("port")) return "port";
  if (normalized.includes("command") || normalized.includes("action")) return "command";
  if (normalized.includes("error")) return "error_code";
  if (normalized.includes("file") || normalized.includes("path")) return "path";
  if (normalized.includes("version") || normalized.includes("revision") || normalized.includes("commit") || normalized.includes("hash")) {
    return "revision";
  }
  if (normalized.includes("url") || normalized.includes("endpoint")) return "endpoint";
  if (normalized.includes("token") || normalized.includes("code") || normalized.includes("identifier") || /\bid\b/.test(normalized)) {
    return "identifier";
  }
  return "labeled_value";
}

function isCommand(value: string): boolean {
  return /^(?:bun|cargo|go|npm|npx|pnpm|pytest|uv|yarn)\b/i.test(value.trim());
}

function clean(value: string, maxChars: number): string {
  return value
    .trim()
    .replace(/^[`'"([{]+|[`'"\])},]+$/g, "")
    .replace(/\s+/g, " ")
    .slice(0, maxChars)
    .trim();
}
