import { readFile } from "node:fs/promises";
import crypto from "node:crypto";
import path from "node:path";

import type {
  AgentProjectDefinition,
  GeneratedMarkdownSource,
  SkillDefinition,
} from "../index";
import { formatSkillMarkdown } from "../skills/format";
import { ARTIFACT_SCHEMAS } from "./constants";
import { writeText } from "./files";

const MAX_MARKDOWN_CHARS = 200_000;
const MAX_SKILL_FILES = 50;

export type CompiledInstructions = {
  schema: string;
  format: "markdown";
  source: string;
  artifactRef: string;
  sourceHash: string;
  charCount: number;
};

export type CompiledSkill = {
  schema: string;
  name: string;
  description: string | null;
  format: "markdown";
  source: string;
  artifactRef: string;
  sourceHash: string;
  charCount: number;
  files: Array<{
    path: string;
    artifactRef: string;
    sourceHash: string;
    charCount: number;
  }>;
};

export type CompiledPromptArtifacts = {
  instructions: CompiledInstructions | null;
  skills: CompiledSkill[];
};

export async function compilePromptArtifacts(
  project: AgentProjectDefinition,
  cwd: string,
  artifactDir: string,
): Promise<CompiledPromptArtifacts> {
  return {
    instructions: await compileInstructions(project.instructions, cwd, artifactDir),
    skills: await Promise.all(
      (project.skills ?? []).map((skill) => compileSkill(skill, cwd, artifactDir)),
    ),
  };
}

async function compileInstructions(
  instructions: AgentProjectDefinition["instructions"],
  cwd: string,
  artifactDir: string,
): Promise<CompiledInstructions | null> {
  if (!instructions) return null;
  if (typeof instructions === "string") {
    return compileMarkdownSource({
      source: instructions,
      cwd,
      artifactRef: path.join(artifactDir, "prompts", "instructions.md"),
    });
  }
  return compileMarkdownSource({
    source: instructions.markdown ?? instructions.source,
    cwd,
    artifactRef: path.join(artifactDir, "prompts", "instructions.md"),
  });
}

async function compileSkill(
  skill: SkillDefinition,
  cwd: string,
  artifactDir: string,
): Promise<CompiledSkill> {
  const skillDir = path.join(artifactDir, "skills", safePathSegment(skill.name));
  const markdown = await resolveMarkdownSource(skill.markdown ?? skill.source, cwd);
  assertBoundedMarkdown(markdown, `Skill ${skill.name}`);
  const body = formatSkillMarkdown({
    name: skill.name,
    description: skill.description ?? null,
    body: markdown,
  });
  const artifactRef = path.join(skillDir, "SKILL.md");
  await writeText(cwd, artifactRef, ensureTrailingNewline(body));

  const files = [];
  const fileEntries = Object.entries(skill.files ?? {}).sort(([left], [right]) => left.localeCompare(right));
  if (fileEntries.length > MAX_SKILL_FILES) {
    throw new Error(`Skill ${skill.name} generated files exceed the limit of ${MAX_SKILL_FILES}.`);
  }
  for (const [relativePath, source] of fileEntries) {
    assertSafeRelativePath(relativePath, `Skill ${skill.name} generated file`);
    const contents = await resolveMarkdownSource(source, cwd);
    assertBoundedMarkdown(contents, `Skill ${skill.name} generated file ${relativePath}`);
    const fileArtifactRef = path.join(skillDir, relativePath);
    await writeText(cwd, fileArtifactRef, ensureTrailingNewline(contents));
    files.push({
      path: relativePath,
      artifactRef: fileArtifactRef,
      sourceHash: hash(contents),
      charCount: contents.length,
    });
  }

  return {
    schema: ARTIFACT_SCHEMAS.skill,
    name: skill.name,
    description: skill.description ?? null,
    format: "markdown",
    source: sourceLabel(skill.markdown ?? skill.source),
    artifactRef,
    sourceHash: hash([markdown, ...files.map((file) => file.sourceHash)].join("\n")),
    charCount: markdown.length,
    files,
  };
}

async function compileMarkdownSource({
  source,
  cwd,
  artifactRef,
}: {
  source: GeneratedMarkdownSource | undefined;
  cwd: string;
  artifactRef: string;
}): Promise<CompiledInstructions> {
  const markdown = await resolveMarkdownSource(source, cwd);
  assertBoundedMarkdown(markdown, "Instructions");
  await writeText(cwd, artifactRef, ensureTrailingNewline(markdown));
  return {
    schema: ARTIFACT_SCHEMAS.instructions,
    format: "markdown",
    source: sourceLabel(source),
    artifactRef,
    sourceHash: hash(markdown),
    charCount: markdown.length,
  };
}

async function resolveMarkdownSource(
  source: GeneratedMarkdownSource | undefined,
  cwd: string,
): Promise<string> {
  if (!source) return "";
  if (typeof source === "function") return source();
  if (source.startsWith("./")) return readFile(path.join(cwd, source.slice(2)), "utf8");
  return source;
}

function sourceLabel(source: GeneratedMarkdownSource | undefined): string {
  if (!source) return "generated";
  return typeof source === "string" && source.startsWith("./") ? source : "generated";
}

function hash(value: string): string {
  return crypto.createHash("sha256").update(value).digest("hex");
}

function ensureTrailingNewline(value: string): string {
  return value.endsWith("\n") ? value : `${value}\n`;
}

function safePathSegment(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "") || "skill";
}

function assertSafeRelativePath(relativePath: string, label: string) {
  if (
    relativePath.length === 0 ||
    path.isAbsolute(relativePath) ||
    relativePath.split(/[\\/]+/).includes("..")
  ) {
    throw new Error(`${label} path must stay inside the generated skill package: ${relativePath}`);
  }
}

function assertBoundedMarkdown(value: string, label: string) {
  if (value.length > MAX_MARKDOWN_CHARS) {
    throw new Error(`${label} markdown exceeds the limit of ${MAX_MARKDOWN_CHARS} characters.`);
  }
}
