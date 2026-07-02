import { promises as fs } from "node:fs";
import path from "node:path";
import type {
  ProjectAgentSdk,
  ProjectAgentSdkDependencyType,
} from "@openpond/contracts";

export const OPENPOND_AGENT_SDK_PACKAGE_NAME = "openpond-agent-sdk";

const PACKAGE_SCAN_DEPTH = 4;
const PACKAGE_MANIFEST_NAME = "package.json";
const DEPENDENCY_FIELDS: ProjectAgentSdkDependencyType[] = [
  "dependencies",
  "devDependencies",
  "peerDependencies",
  "optionalDependencies",
];
const IGNORED_PACKAGE_SCAN_DIRS = new Set([
  ".git",
  ".next",
  ".turbo",
  "build",
  "coverage",
  "dist",
  "node_modules",
  "out",
]);

export async function detectProjectAgentSdk(input: {
  selectedPath: string;
  workspacePath: string;
}): Promise<ProjectAgentSdk | null> {
  const candidates: string[] = [];
  const seen = new Set<string>();
  await collectPackageManifestCandidates(input.selectedPath, candidates, seen, PACKAGE_SCAN_DEPTH);
  if (input.workspacePath !== input.selectedPath) {
    await collectPackageManifestCandidates(input.workspacePath, candidates, seen, PACKAGE_SCAN_DEPTH);
  }

  for (const manifestPath of candidates) {
    const detected = await detectProjectAgentSdkManifest(manifestPath);
    if (detected) return detected;
  }
  return null;
}

async function collectPackageManifestCandidates(
  basePath: string,
  candidates: string[],
  seen: Set<string>,
  depth: number,
): Promise<void> {
  if (depth < 0 || !(await directoryExists(basePath))) return;

  const manifestPath = path.join(basePath, PACKAGE_MANIFEST_NAME);
  if (!seen.has(manifestPath) && (await fileExists(manifestPath))) {
    seen.add(manifestPath);
    candidates.push(manifestPath);
  }
  if (depth === 0) return;

  const entries = await fs.readdir(basePath, { withFileTypes: true }).catch(() => []);
  for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
    if (!entry.isDirectory()) continue;
    if (entry.name.startsWith(".") || IGNORED_PACKAGE_SCAN_DIRS.has(entry.name)) continue;
    await collectPackageManifestCandidates(path.join(basePath, entry.name), candidates, seen, depth - 1);
  }
}

async function detectProjectAgentSdkManifest(manifestPath: string): Promise<ProjectAgentSdk | null> {
  let manifest: unknown;
  try {
    manifest = JSON.parse(await fs.readFile(manifestPath, "utf8"));
  } catch {
    return null;
  }
  const record = asRecord(manifest);
  for (const dependencyType of DEPENDENCY_FIELDS) {
    const dependencies = asRecord(record[dependencyType]);
    const version = stringValue(dependencies[OPENPOND_AGENT_SDK_PACKAGE_NAME]);
    if (!version) continue;
    return {
      detected: true,
      packageName: OPENPOND_AGENT_SDK_PACKAGE_NAME,
      rootPath: path.dirname(manifestPath),
      manifestPath,
      version,
      dependencyType,
    };
  }
  return null;
}

async function fileExists(filePath: string): Promise<boolean> {
  try {
    const stat = await fs.stat(filePath);
    return stat.isFile();
  } catch {
    return false;
  }
}

async function directoryExists(filePath: string): Promise<boolean> {
  try {
    const stat = await fs.stat(filePath);
    return stat.isDirectory();
  } catch {
    return false;
  }
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function stringValue(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}
