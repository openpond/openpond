import { promises as fs } from "node:fs";
import { existsSync } from "node:fs";
import crypto from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { runProcessCommand } from "./process-runner";

const moduleDir = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(moduleDir, "..", "..");
const RULES_PATH = path.join(
  rootDir,
  "test",
  "openpond-code",
  "prompts",
  "opentool-rules.txt"
);

export function hashString(input: string): string {
  return crypto.createHash("sha256").update(input).digest("hex");
}

export async function loadRulesText(): Promise<string> {
  const content = await fs.readFile(RULES_PATH, "utf-8");
  return content.trim();
}

export async function hashDirectory(
  dir: string,
  ignore: string[] = []
): Promise<string> {
  const glob = new Bun.Glob("**/*");
  const entries: string[] = [];
  for await (const entry of glob.scan({ cwd: dir, dot: true })) {
    if (ignore.some((pattern) => entry.startsWith(pattern))) continue;
    const full = path.join(dir, entry);
    const stat = await fs.stat(full);
    if (stat.isFile()) {
      entries.push(entry);
    }
  }
  entries.sort();
  const hash = crypto.createHash("sha256");
  for (const entry of entries) {
    const full = path.join(dir, entry);
    const content = await fs.readFile(full, "utf-8");
    hash.update(`${entry}\n`);
    hash.update(content);
    hash.update("\n");
  }
  return hash.digest("hex");
}

export async function getTemplateHash(): Promise<{
  templatePath: string;
  templateHash: string;
}> {
  const templatePath =
    process.env.OPENPOND_TEMPLATE_PATH ||
    process.env.OPENTOOL_PATH ||
    resolveLocalTemplatePath();
  if (!templatePath) {
    throw new Error("OPENPOND_TEMPLATE_PATH or OPENTOOL_PATH is required");
  }
  const ignore = [".git", "node_modules", "dist", "build"];
  const templateHash = await hashDirectory(templatePath, ignore);
  return { templatePath, templateHash };
}

function resolveLocalTemplatePath(): string | null {
  const candidate = path.join(
    rootDir,
    "test",
    "openpond-code",
    "templates",
    "opentool-base"
  );
  return existsSync(candidate) ? candidate : null;
}

export async function getGitHash(rootDir: string): Promise<string | null> {
  try {
    const result = await runProcessCommand("git", ["rev-parse", "HEAD"], {
      cwd: rootDir,
    });
    if (result.code !== 0) return null;
    return result.stdout.trim();
  } catch {
    return null;
  }
}
