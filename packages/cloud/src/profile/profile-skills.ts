import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { readdir, readFile, stat } from "node:fs/promises";
import path from "node:path";
import yaml from "js-yaml";

import type {
  OpenPondProfileSkill,
  OpenPondProfileSkillCatalogState,
} from "./local-profile-types.js";

export const PROFILE_SKILLS_DIR = "skills";
export const PROFILE_SKILL_FILE = "SKILL.md";
export const PROFILE_SKILL_MAX_CHARS = 80_000;

type LoadedProfileSkills = {
  skillCatalog: OpenPondProfileSkillCatalogState;
  skills: OpenPondProfileSkill[];
};

export type OpenPondProfileSkillReadResult = {
  name: string;
  description: string;
  body: string;
  path: string;
  sourcePath: string;
  sourceHash: string;
  charCount: number;
};

type ParsedSkillMarkdown = {
  name: string | null;
  description: string | null;
  body: string;
  messages: string[];
};

export async function loadProfileSkills(profileSourcePath: string): Promise<LoadedProfileSkills> {
  const skillsDir = path.join(profileSourcePath, PROFILE_SKILLS_DIR);
  if (!existsSync(skillsDir)) {
    return {
      skillCatalog: emptyProfileSkillCatalogState({ stale: false }),
      skills: [],
    };
  }

  try {
    const entries = await readdir(skillsDir, { withFileTypes: true });
    const skills = (
      await Promise.all(
        entries
          .filter((entry) => entry.isDirectory())
          .map((entry) => loadProfileSkillDirectory(profileSourcePath, entry.name)),
      )
    ).sort((left, right) => left.name.localeCompare(right.name) || left.path.localeCompare(right.path));
    markDuplicateSkillNames(skills);
    const generatedAt = await latestSkillMtime(profileSourcePath, skills);
    return {
      skillCatalog: {
        skillCount: skills.length,
        generatedAt,
        stale: false,
        error: null,
      },
      skills,
    };
  } catch (error) {
    return {
      skillCatalog: emptyProfileSkillCatalogState({
        stale: true,
        error: error instanceof Error ? error.message : String(error),
      }),
      skills: [],
    };
  }
}

export function parseProfileSkillMarkdown(markdown: string): ParsedSkillMarkdown {
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
    frontmatter = yaml.load(frontmatterSource);
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

export async function readProfileSkill(input: {
  profileSourcePath: string;
  name: string;
}): Promise<OpenPondProfileSkillReadResult> {
  const name = input.name.trim();
  if (!isKebabCaseSkillName(name)) {
    throw new Error("Profile skill name must be lowercase kebab-case.");
  }
  const result = await loadProfileSkills(input.profileSourcePath);
  const skill = result.skills.find((candidate) => candidate.name === name);
  if (!skill) {
    throw new Error(`Profile skill not found: ${name}`);
  }
  if (!skill.enabled || skill.validationStatus !== "valid") {
    const details = skill.validationMessages.length > 0
      ? ` ${skill.validationMessages.join(" ")}`
      : "";
    throw new Error(`Profile skill ${name} is not valid.${details}`);
  }
  const absolutePath = path.join(input.profileSourcePath, skill.path);
  const markdown = await readFile(absolutePath, "utf8");
  const parsed = parseProfileSkillMarkdown(markdown);
  if (parsed.messages.length > 0) {
    throw new Error(`Profile skill ${name} is not valid. ${parsed.messages.join(" ")}`);
  }
  return {
    name: skill.name,
    description: skill.description,
    body: parsed.body,
    path: skill.path,
    sourcePath: skill.sourcePath,
    sourceHash: skill.sourceHash,
    charCount: skill.charCount,
  };
}

function emptyProfileSkillCatalogState(input: {
  stale?: boolean;
  error?: string | null;
} = {}): OpenPondProfileSkillCatalogState {
  return {
    skillCount: 0,
    generatedAt: null,
    stale: input.stale ?? true,
    error: input.error ?? null,
  };
}

async function loadProfileSkillDirectory(
  profileSourcePath: string,
  directoryName: string,
): Promise<OpenPondProfileSkill> {
  const relativePath = path.join(PROFILE_SKILLS_DIR, directoryName, PROFILE_SKILL_FILE).replace(/\\/g, "/");
  const absolutePath = path.join(profileSourcePath, relativePath);
  const messages: string[] = [];
  const entries = await readdir(path.join(profileSourcePath, PROFILE_SKILLS_DIR, directoryName), { withFileTypes: true });
  for (const entry of entries) {
    if (entry.name === PROFILE_SKILL_FILE && entry.isFile()) continue;
    messages.push(`Profile skills only support ${PROFILE_SKILL_FILE}; unsupported entry: ${entry.name}`);
  }

  let contents = "";
  if (!existsSync(absolutePath)) {
    messages.push(`Missing ${PROFILE_SKILL_FILE}.`);
  } else {
    contents = await readFile(absolutePath, "utf8");
  }
  if (contents.length > PROFILE_SKILL_MAX_CHARS) {
    messages.push(`Skill markdown exceeds the limit of ${PROFILE_SKILL_MAX_CHARS} characters.`);
  }

  const parsed = parseProfileSkillMarkdown(contents);
  messages.push(...parsed.messages);
  const name = parsed.name ?? directoryName;
  const description = parsed.description ?? "";
  if (!isKebabCaseSkillName(name)) {
    messages.push("Skill name must be lowercase kebab-case.");
  }
  if (name !== directoryName) {
    messages.push(`Skill name must match its directory name (${directoryName}).`);
  }

  return {
    name,
    description,
    path: relativePath,
    scope: "profile",
    enabled: messages.length === 0,
    sourcePath: profileSourcePath,
    charCount: contents.length,
    sourceHash: sha256Hex(contents),
    validationStatus: messages.length > 0 ? "error" : "valid",
    validationMessages: messages,
  };
}

function markDuplicateSkillNames(skills: OpenPondProfileSkill[]): void {
  const counts = new Map<string, number>();
  for (const skill of skills) {
    counts.set(skill.name, (counts.get(skill.name) ?? 0) + 1);
  }
  for (const skill of skills) {
    if ((counts.get(skill.name) ?? 0) <= 1) continue;
    skill.enabled = false;
    skill.validationStatus = "error";
    skill.validationMessages = [
      ...skill.validationMessages,
      `Duplicate skill name: ${skill.name}`,
    ];
  }
}

async function latestSkillMtime(
  profileSourcePath: string,
  skills: OpenPondProfileSkill[],
): Promise<string | null> {
  let latest = 0;
  for (const skill of skills) {
    const fileStat = await stat(path.join(profileSourcePath, skill.path)).catch(() => null);
    if (!fileStat?.isFile()) continue;
    latest = Math.max(latest, fileStat.mtimeMs);
  }
  return latest > 0 ? new Date(latest).toISOString() : null;
}

function isKebabCaseSkillName(value: string): boolean {
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

function sha256Hex(contents: string): string {
  return createHash("sha256").update(contents).digest("hex");
}
