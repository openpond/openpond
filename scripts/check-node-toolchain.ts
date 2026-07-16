import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const skippedDirectories = new Set([
  ".git",
  ".openpond",
  ".stage",
  "coverage",
  "dist",
  "node_modules",
  "release",
  "release-cli",
  "stage",
  "tmp",
]);

const skippedFiles = new Set([
  "docs/subagent-lifecycle-working-notes.md",
  "packages/agent-sdk/examples/water-estimator-agent/CROSSWALK.md",
  "scripts/check-node-toolchain.ts",
]);

const compatibilityFiles = new Set([
  "apps/cli/src/cli/project-source-upload.ts",
  "apps/server/src/openpond/command-access.ts",
  "apps/server/src/openpond/context-compaction/file-ledger.ts",
  "apps/server/src/runtime/subagents/progress-reducer.ts",
  "apps/server/src/runtime/terminal-sessions.ts",
  "apps/server/src/training/sandboxed-verifier.ts",
  "apps/server/src/workspace/workspace-lsp.ts",
  "apps/web/src/components/chat/workspaceSyntax.tsx",
  "apps/web/src/lib/chat-activity-summary.ts",
  "packages/cloud/src/profile/profile-git.ts",
  "packages/cloud/src/profile/profile-source-upload.ts",
  "packages/codex-provider/src/binary.ts",
  "packages/contracts/src/subagents.ts",
  "tests/openpond-command-access.test.ts",
  "tests/profile-source-upload.test.ts",
  "tests/release-workflow.test.ts",
]);

const forbiddenPatterns: Array<{ label: string; pattern: RegExp }> = [
  { label: "Bun runtime API", pattern: /\bBun\b|\bbun:(?:test|sqlite)\b/ },
  { label: "Bun executable command", pattern: /\b(?:bun|bunx)\s+(?:add|build|install|remove|run|test|x)\b/ },
  { label: "Bun shebang", pattern: /^#!.*\benv\s+bun\b/m },
  { label: "Bun package dependency", pattern: /@types\/bun|["']packageManager["']\s*:\s*["']bun@/ },
  { label: "Bun CI setup", pattern: /oven-sh\/setup-bun|\bsetup-bun\b/ },
  { label: "Bun cache or install path", pattern: /(?:^|[/'"`])\.bun(?:[/'"`]|$)/m },
  { label: "Bun lockfile reference", pattern: /\bbun\.lockb?\b/ },
];

const findings: string[] = [];
for (const file of await listFiles(root)) {
  const relative = path.relative(root, file).split(path.sep).join("/");
  if (skippedFiles.has(relative) || relative.startsWith("docs/working-docs/")) continue;
  if (relative.endsWith(".tsbuildinfo")) continue;
  if (path.basename(relative) === "bun.lock" || path.basename(relative) === "bun.lockb") {
    findings.push(`${relative}: Bun lockfile is not allowed`);
    continue;
  }

  const contents = await readFile(file);
  if (contents.includes(0)) continue;
  const source = contents.toString("utf8");
  for (const { label, pattern } of forbiddenPatterns) {
    if (!pattern.test(source) || compatibilityFiles.has(relative)) continue;
    const line = source.slice(0, source.search(pattern)).split("\n").length;
    findings.push(`${relative}:${line}: ${label}`);
  }
}

if (findings.length > 0) {
  console.error("[node-toolchain] OpenPond-owned Bun dependencies or commands remain:");
  for (const finding of findings) console.error(`  ${finding}`);
  console.error(
    "User-project Bun compatibility must stay in an explicitly reviewed compatibility file.",
  );
  process.exitCode = 1;
} else {
  console.log(
    `Node-only toolchain check passed; ${compatibilityFiles.size} reviewed compatibility files may recognize user-owned Bun projects.`,
  );
}

async function listFiles(directory: string): Promise<string[]> {
  const files: string[] = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (
      entry.isDirectory() &&
      (skippedDirectories.has(entry.name) ||
        entry.name === ".venv" ||
        entry.name.startsWith(".openpond"))
    ) continue;
    const fullPath = path.join(directory, entry.name);
    if (entry.isDirectory()) files.push(...await listFiles(fullPath));
    else if (entry.isFile()) files.push(fullPath);
  }
  return files;
}
