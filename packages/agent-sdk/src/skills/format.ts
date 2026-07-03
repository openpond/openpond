import { parse as parseYaml } from "yaml";

export const SKILL_MARKDOWN_FILE = "SKILL.md";

export type ParsedSkillMarkdown = {
  name: string | null;
  description: string | null;
  body: string;
  messages: string[];
};

export function formatSkillMarkdown(input: {
  name: string;
  description?: string | null;
  body: string;
}): string {
  const body = input.body.trim();
  return [
    "---",
    `name: ${JSON.stringify(input.name)}`,
    `description: ${JSON.stringify(input.description ?? "")}`,
    "---",
    "",
    body,
    "",
  ].join("\n");
}

export function parseSkillMarkdown(markdown: string): ParsedSkillMarkdown {
  const messages: string[] = [];
  const match = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)([\s\S]*)$/.exec(markdown);
  if (!match) {
    return {
      name: null,
      description: null,
      body: markdown.trim(),
      messages: ["SKILL.md must start with YAML frontmatter bounded by ---."],
    };
  }

  const frontmatterSource = match[1] ?? "";
  const body = (match[2] ?? "").trim();
  let frontmatter: unknown;
  try {
    frontmatter = parseYaml(frontmatterSource);
  } catch (error) {
    messages.push(`SKILL.md frontmatter is invalid YAML: ${error instanceof Error ? error.message : String(error)}`);
  }

  const record = asRecord(frontmatter);
  const name = text(record?.name);
  const description = text(record?.description);
  if (!name) messages.push("Skill frontmatter must include a non-empty name.");
  if (!description) messages.push("Skill frontmatter must include a non-empty description.");
  if (!body) messages.push("Skill body must be non-empty markdown.");

  return {
    name,
    description,
    body,
    messages,
  };
}

export function isKebabCaseSkillName(value: string): boolean {
  return /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(value);
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function text(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}
