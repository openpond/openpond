#!/usr/bin/env node
import { readFile, readdir, stat } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const maxLines = 1_000;
const ignoredDirs = new Set(["node_modules", "dist", ".openpond-test-fixtures", ".git"]);
await checkLineCounts();
await checkPackageExports();
await checkPublicImports();
await checkNoRealSecrets();

console.log("Package hygiene check passed.");

async function checkLineCounts() {
  const files = await listFiles(root);
  for (const file of files) {
    if (isGeneratedOutput(file)) continue;
    if (!/\.(ts|md|json)$/.test(file)) continue;
    const text = await readFile(path.join(root, file), "utf8");
    const lines = text.split("\n").length;
    if (lines > maxLines) {
      throw new Error(`${file} has ${lines} lines, above the ${maxLines} line limit.`);
    }
  }
}

function isGeneratedOutput(file: string) {
  return (
    file.includes("/.openpond/") ||
    file.includes("/.openpond-negative/") ||
    file.includes("/generated/")
  );
}

async function checkPackageExports() {
  const packageJson = JSON.parse(await readFile(path.join(root, "package.json"), "utf8")) as {
    exports: Record<string, unknown>;
  };
  for (const exportName of Object.keys(packageJson.exports)) {
    if (exportName === "." || exportName === "./package.json" || exportName === "./cli") continue;
    const source = path.join(root, "src", exportName.replace(/^\.\//, ""), "index.ts");
    await mustExist(source);
  }
}

async function checkPublicImports() {
  const files = await listFiles(root);
  const importPattern = /from\s+["'](?:\.\.\/){1,}src\/|from\s+["']openpond-agent-sdk\/(?:core|commands|cli)\b/;
  const offenders: string[] = [];
  for (const file of files) {
    if (!file.startsWith("examples/") && !file.startsWith("templates/")) continue;
    if (!file.endsWith(".ts")) continue;
    const text = await readFile(path.join(root, file), "utf8");
    if (importPattern.test(text)) offenders.push(file);
  }
  if (offenders.length > 0) {
    throw new Error(`Public fixtures import private SDK internals: ${offenders.join(", ")}`);
  }
}

async function checkNoRealSecrets() {
  const files = await listFiles(root);
  const secretPattern = /(sk-[A-Za-z0-9]{20,}|ghp_[A-Za-z0-9]{20,}|xox[baprs]-[A-Za-z0-9-]{20,}|-----BEGIN (?:RSA |OPENSSH |EC |)?PRIVATE KEY-----)/;
  const offenders: string[] = [];
  for (const file of files) {
    if (!/\.(ts|md|json|yaml|yml)$/.test(file)) continue;
    const text = await readFile(path.join(root, file), "utf8");
    if (secretPattern.test(text)) offenders.push(file);
  }
  if (offenders.length > 0) {
    throw new Error(`Files contain values matching real secret patterns: ${offenders.join(", ")}`);
  }
}

async function listFiles(dir: string, prefix = ""): Promise<string[]> {
  const entries = await readdir(dir);
  const files: string[] = [];
  for (const entry of entries) {
    if (ignoredDirs.has(entry)) continue;
    if (entry === ".env" || entry.startsWith(".env.")) continue;
    const fullPath = path.join(dir, entry);
    const relativePath = path.join(prefix, entry);
    const info = await stat(fullPath);
    if (info.isDirectory()) {
      files.push(...await listFiles(fullPath, relativePath));
    } else {
      files.push(relativePath);
    }
  }
  return files;
}

async function mustExist(filePath: string) {
  try {
    await stat(filePath);
  } catch {
    throw new Error(`Required file is missing: ${path.relative(root, filePath)}`);
  }
}
