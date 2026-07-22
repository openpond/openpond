import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { readdir, readFile, realpath, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { parseProfileSkillMarkdown } from "@openpond/cloud";
import type {
  CodexPersonalSkill,
  SkillSourceFile,
  SkillSourceScope,
} from "@openpond/contracts";

const MAX_SKILL_SOURCE_FILE_BYTES = 2 * 1024 * 1024;
const TEXT_SKILL_FILE_EXTENSIONS = new Set([
  ".bash", ".cjs", ".css", ".html", ".js", ".json", ".jsx", ".md",
  ".mjs", ".py", ".scss", ".sh", ".svg", ".toml", ".ts", ".tsx",
  ".txt", ".xml", ".yaml", ".yml",
]);

export function codexPersonalSkillsRoot(
  codexHome = process.env.CODEX_HOME?.trim() || path.join(os.homedir(), ".codex"),
): string {
  return path.join(codexHome, "skills");
}

export async function loadCodexPersonalSkills(
  skillsRoot = codexPersonalSkillsRoot(),
): Promise<CodexPersonalSkill[]> {
  if (!existsSync(skillsRoot)) return [];
  const entries = await readdir(skillsRoot, { withFileTypes: true }).catch(() => []);
  const skills = await Promise.all(
    entries
      .filter((entry) => entry.isDirectory() && !entry.name.startsWith("."))
      .map((entry) => loadCodexPersonalSkillDirectory(skillsRoot, entry.name)),
  );
  return skills.sort((left, right) => left.name.localeCompare(right.name));
}

export async function readCodexPersonalSkillFile(
  skillName: string,
  relativeFilePath: string,
  skillsRoot = codexPersonalSkillsRoot(),
): Promise<SkillSourceFile> {
  assertSkillName(skillName);
  const packageRoot = await realpath(path.join(skillsRoot, skillName));
  return readSkillSourceFile({
    skillName,
    scope: "codex",
    packageRoot,
    relativeFilePath,
  });
}

export async function readSkillSourceFile(input: {
  skillName: string;
  scope: SkillSourceScope;
  packageRoot: string;
  relativeFilePath: string;
}): Promise<SkillSourceFile> {
  assertSkillName(input.skillName);
  const normalizedPath = normalizeSkillFilePath(input.relativeFilePath);
  const packageRoot = await realpath(input.packageRoot);
  const absolutePath = await realpath(path.join(packageRoot, normalizedPath));
  assertPathWithinRoot(packageRoot, absolutePath);
  const fileStat = await stat(absolutePath);
  if (!fileStat.isFile()) throw new Error("Skill source path is not a file.");
  if (fileStat.size > MAX_SKILL_SOURCE_FILE_BYTES) {
    throw new Error("Skill source file exceeds the 2 MB preview limit.");
  }
  const bytes = await readFile(absolutePath);
  const isBinary = isBinarySkillFile(normalizedPath, bytes);
  return {
    skillName: input.skillName,
    scope: input.scope,
    path: normalizedPath,
    byteSize: bytes.byteLength,
    isBinary,
    content: isBinary ? null : bytes.toString("utf8"),
  };
}

async function loadCodexPersonalSkillDirectory(
  skillsRoot: string,
  directoryName: string,
): Promise<CodexPersonalSkill> {
  const sourcePath = path.join(skillsRoot, directoryName);
  const skillPath = path.join(sourcePath, "SKILL.md");
  const messages: string[] = [];
  let contents = "";
  if (!existsSync(skillPath)) {
    messages.push("Missing SKILL.md.");
  } else {
    contents = await readFile(skillPath, "utf8").catch((error) => {
      messages.push(error instanceof Error ? error.message : String(error));
      return "";
    });
  }
  const parsed = parseProfileSkillMarkdown(contents);
  messages.push(...parsed.messages);
  const name = parsed.name ?? directoryName;
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(name)) {
    messages.push("Skill name must be lowercase kebab-case.");
  }
  if (name !== directoryName) {
    messages.push(`Skill name must match its directory name (${directoryName}).`);
  }
  const packageFiles = await listPackageFiles(sourcePath);
  const updatedAt = await latestPackageMtime(sourcePath, packageFiles);
  const validationMessages = [...new Set(messages)];
  return {
    name,
    description: parsed.description ?? "",
    path: skillPath,
    sourcePath,
    enabled: validationMessages.length === 0,
    charCount: contents.length,
    sourceHash: createHash("sha256").update(contents).digest("hex"),
    validationStatus: validationMessages.length === 0 ? "valid" : "error",
    validationMessages,
    resourceFiles: packageFiles.filter((file) => file !== "SKILL.md"),
    updatedAt,
  };
}

async function listPackageFiles(root: string): Promise<string[]> {
  const files: string[] = [];
  async function visit(directory: string, prefix: string): Promise<void> {
    const entries = await readdir(directory, { withFileTypes: true }).catch(() => []);
    await Promise.all(entries.map(async (entry) => {
      const relativePath = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        await visit(path.join(directory, entry.name), relativePath);
      } else if (entry.isFile()) {
        files.push(relativePath);
      }
    }));
  }
  await visit(root, "");
  return files.sort();
}

async function latestPackageMtime(root: string, files: string[]): Promise<string | null> {
  const mtimes = await Promise.all(
    files.map((file) => stat(path.join(root, file)).then((value) => value.mtimeMs, () => 0)),
  );
  const latest = mtimes.reduce((current, value) => Math.max(current, value), 0);
  return latest > 0 ? new Date(latest).toISOString() : null;
}

function assertSkillName(skillName: string): void {
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(skillName)) {
    throw new Error("Invalid skill name.");
  }
}

function normalizeSkillFilePath(filePath: string): string {
  const normalized = filePath.trim().replace(/\\/g, "/");
  if (
    !normalized
    || normalized.startsWith("/")
    || normalized.split("/").some((segment) => !segment || segment === "." || segment === "..")
  ) {
    throw new Error("Invalid skill source path.");
  }
  return normalized;
}

function assertPathWithinRoot(root: string, target: string): void {
  const relative = path.relative(root, target);
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error("Skill source path escapes its package.");
  }
}

function isBinarySkillFile(filePath: string, bytes: Buffer): boolean {
  if (TEXT_SKILL_FILE_EXTENSIONS.has(path.extname(filePath).toLowerCase())) return false;
  return bytes.subarray(0, Math.min(bytes.length, 8_192)).includes(0);
}
