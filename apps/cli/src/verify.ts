import { promises as fs } from "node:fs";
import path from "node:path";
import { runProcessCommand } from "./process-runner";

type VerificationResult = {
  step: "validate" | "build" | "rules";
  ok: boolean;
  output: string;
  reasons?: string[];
};

async function runCommand(
  cmd: string[],
  cwd: string
): Promise<VerificationResult> {
  const result = await runProcessCommand(cmd[0]!, cmd.slice(1), { cwd });
  const output = [result.stdout, result.stderr].filter(Boolean).join("\n").trim();
  return {
    step: cmd[1] as "validate" | "build",
    ok: result.code === 0,
    output,
  };
}

export async function verifyWorkspace(
  rootDir: string
): Promise<VerificationResult[]> {
  const results: VerificationResult[] = [];
  results.push(await runCommand(["bunx", "opentool", "validate"], rootDir));
  results.push(await runCommand(["bunx", "opentool", "build"], rootDir));
  return results;
}

function findToolFiles(filesWritten: string[]): string[] {
  const seen = new Set<string>();
  const toolFiles: string[] = [];
  for (const file of filesWritten) {
    if (!file.startsWith("tools/") || !file.endsWith(".ts")) continue;
    if (seen.has(file)) continue;
    seen.add(file);
    toolFiles.push(file);
  }
  return toolFiles;
}

function hasRegex(content: string, pattern: RegExp): boolean {
  return pattern.test(content);
}

export async function verifyPromptRules(
  rootDir: string,
  filesWritten: string[],
  promptText: string,
  assistantText: string
): Promise<VerificationResult> {
  const toolFiles = findToolFiles(filesWritten);
  const errors: string[] = [];
  const promptLower = promptText.toLowerCase();

  if (toolFiles.length === 0) {
    errors.push("no tool file updated under tools/");
  }
  if (toolFiles.length > 1) {
    errors.push(`multiple tool files updated: ${toolFiles.join(", ")}`);
  }

  const target = toolFiles[0];
  if (target) {
    const abs = path.join(rootDir, target);
    const content = await fs.readFile(abs, "utf-8");
    const hasGet = hasRegex(content, /export\s+async\s+function\s+GET\b/);
    const hasPost = hasRegex(content, /export\s+async\s+function\s+POST\b/);
    if ((hasGet && hasPost) || (!hasGet && !hasPost)) {
      errors.push("tool must export exactly one of GET or POST");
    }
    if (hasPost) {
      if (!hasRegex(content, /export\s+const\s+schema\b/)) {
        errors.push("POST tool missing export const schema");
      }
      if (!hasRegex(content, /request\.json\(\)/)) {
        errors.push("POST tool missing request.json() parsing");
      }
    }
    if (hasGet) {
      if (!hasRegex(content, /schedule\s*:\s*\{[^}]*cron/s)) {
        errors.push("GET tool missing profile.schedule.cron");
      }
      if (!hasRegex(content, /export\s+const\s+profile\b/)) {
        errors.push("GET tool missing export const profile");
      }
      if (hasRegex(content, /export\s+const\s+schema\b/)) {
        errors.push("GET tool should not export schema");
      }
    }
    if (hasRegex(content, /TODO[:\s]/)) {
      errors.push("tool contains TODO placeholder");
    }
    if (
      hasRegex(content, /import\s+\{[^}]*\bstore\b[^}]*\}\s+from\s+["']zod["']/)
    ) {
      errors.push("store must be imported from opentool/store (not zod)");
    }
  }

  if (assistantText.toLowerCase().includes("new builder chat")) {
    errors.push("assistant deflected to new builder chat");
  }

  const allowMetadata =
    promptLower.includes("metadata") || promptLower.includes("keywords");
  const allowReadme =
    promptLower.includes("readme") ||
    promptLower.includes("docs") ||
    promptLower.includes("documentation");
  const allowPackage =
    promptLower.includes("package.json") ||
    promptLower.includes("dependencies") ||
    promptLower.includes("dependency") ||
    promptLower.includes("package");
  const allowExtras =
    promptLower.includes("additional files") ||
    promptLower.includes("src/") ||
    promptLower.includes("lib/");

  const extraFiles = filesWritten.filter((file) => !file.startsWith("tools/"));
  for (const file of extraFiles) {
    if (file === "metadata.ts" && !allowMetadata) {
      errors.push("metadata.ts edited without prompt request");
    } else if (file.toLowerCase() === "readme.md" && !allowReadme) {
      errors.push("README.md edited without prompt request");
    } else if (file === "package.json" && !allowPackage) {
      errors.push("package.json edited without prompt request");
    } else if (
      !file.startsWith("src/") &&
      !file.startsWith("lib/") &&
      file !== "metadata.ts" &&
      file.toLowerCase() !== "readme.md" &&
      file !== "package.json"
    ) {
      errors.push(`unsupported file edited: ${file}`);
    } else if (
      (file.startsWith("src/") || file.startsWith("lib/")) &&
      !allowExtras
    ) {
      errors.push(`${file} edited without prompt request`);
    }
  }

  const packagePath = path.join(rootDir, "package.json");
  try {
    const pkg = await fs.readFile(packagePath, "utf-8");
    if (!pkg.includes('"opentool"')) {
      errors.push("package.json missing opentool dependency");
    }
    if (!pkg.includes('"zod"')) {
      errors.push("package.json missing zod dependency");
    }
    if (!pkg.includes('"validate"')) {
      errors.push("package.json missing validate script");
    }
  } catch {
    errors.push("package.json missing");
  }

  return {
    step: "rules",
    ok: errors.length === 0,
    output: errors.join("; "),
    reasons: errors,
  };
}
