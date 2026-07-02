const DEFAULT_CHAT_ACTION_LABEL = "chat";

type ProfileAgentLabelInput = {
  actionId?: string | null;
  description?: string | null;
  label?: string | null;
  name?: string | null;
};

const GENERATED_PREFIXES = [
  "help me",
  "please",
  "can you",
  "could you",
  "make",
  "create",
  "build",
];

const LABEL_STOP_WORDS = new Set([
  "a",
  "an",
  "and",
  "for",
  "from",
  "i",
  "me",
  "my",
  "of",
  "our",
  "please",
  "produce",
  "summary",
  "the",
  "to",
  "with",
]);

export function shortProfileAgentLabel(input: ProfileAgentLabelInput): string {
  const explicitLabel = cleanText(input.label);
  if (explicitLabel && !isGenericChatLabel(explicitLabel)) return conciseTitle(explicitLabel);

  const explicitName = cleanText(input.name);
  if (explicitName && !isGenericChatLabel(explicitName)) {
    return conciseTitle(explicitName);
  }

  const source = cleanText(input.actionId)?.replace(/\.chat$/i, "") ?? "";
  return conciseGeneratedTitle(source || explicitLabel || "Profile Agent");
}

export function isGenericChatLabel(value: string): boolean {
  return value.trim().toLowerCase() === DEFAULT_CHAT_ACTION_LABEL;
}

function conciseGeneratedTitle(value: string): string {
  const source = stripGeneratedPrefix(
    value
      .replace(/\.chat$/i, "")
      .replace(/[._-]+/g, " ")
      .replace(/\s+/g, " ")
      .trim(),
  );
  const tokens = source
    .toLowerCase()
    .split(/\s+/)
    .map((token) => token.replace(/[^a-z0-9]/g, ""))
    .filter((token) => token && !LABEL_STOP_WORDS.has(token));

  const compact = tokens
    .map((token) => (token.length > 3 && token.endsWith("s") ? token.slice(0, -1) : token))
    .slice(0, 3);

  return titleCaseWords(compact.length ? compact.join(" ") : source || value);
}

function conciseTitle(value: string): string {
  return titleCaseWords(value).split(/\s+/).slice(0, 4).join(" ");
}

function stripGeneratedPrefix(value: string): string {
  let next = value.trim();
  for (const prefix of GENERATED_PREFIXES) {
    if (next.toLowerCase().startsWith(`${prefix} `)) {
      next = next.slice(prefix.length).trim();
      break;
    }
  }
  return next;
}

function cleanText(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function titleCaseWords(value: string): string {
  return value
    .replace(/[._-]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/\b[a-z0-9]/gi, (letter) => letter.toUpperCase());
}
