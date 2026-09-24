import { constants as fsConstants, promises as fs } from "node:fs";
import path from "node:path";

export async function sourceFilesForImport(source: string): Promise<string[]> {
  const stats = await fs.lstat(source);
  if (stats.isSymbolicLink()) throw new Error(`Profile source cannot be a symlink: ${source}`);
  if (stats.isFile()) return [path.basename(source)];
  if (!stats.isDirectory()) throw new Error(`Profile source is not a file or directory: ${source}`);
  return listRegularFiles(source);
}

export function selectAgentPrimaryFile(files: string[]): string {
  for (const candidate of ["agent.ts", "index.ts", "agent/agent.ts", "agent.yaml", "agent.yml", "agent.json"]) {
    if (files.includes(candidate)) return candidate;
  }
  return files[0]!;
}

export async function copyRegularFile(source: string, target: string): Promise<void> {
  const stats = await fs.lstat(source);
  if (!stats.isFile() || stats.isSymbolicLink()) {
    throw new Error(`Harness import source must be a regular non-symlink file: ${source}`);
  }
  await fs.mkdir(path.dirname(target), { recursive: true });
  await fs.copyFile(source, target, fsConstants.COPYFILE_EXCL);
}

export function mediaTypeForPath(filePath: string): string {
  const extension = path.extname(filePath).toLowerCase();
  if ([".md", ".txt"].includes(extension)) return extension === ".md" ? "text/markdown" : "text/plain";
  if ([".json"].includes(extension)) return "application/json";
  if ([".yaml", ".yml"].includes(extension)) return "application/yaml";
  if ([".ts", ".tsx", ".js", ".mjs", ".cjs"].includes(extension)) return "text/javascript";
  if (extension === ".py") return "text/x-python";
  return "application/octet-stream";
}

export async function resolveContainedRegularFile(root: string, relativePath: string): Promise<string> {
  const candidate = path.resolve(root, ...relativePath.split("/"));
  const relative = path.relative(root, candidate);
  if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error(`Harness source path escapes its root: ${relativePath}`);
  }
  const stats = await fs.lstat(candidate);
  if (!stats.isFile() || stats.isSymbolicLink()) {
    throw new Error(`Harness source path must be a regular non-symlink file: ${relativePath}`);
  }
  const real = await fs.realpath(candidate);
  const realRelative = path.relative(await fs.realpath(root), real);
  if (realRelative.startsWith("..") || path.isAbsolute(realRelative)) {
    throw new Error(`Harness source path resolves outside its root: ${relativePath}`);
  }
  return candidate;
}

export async function listRegularFiles(root: string, directory = root): Promise<string[]> {
  const entries = await fs.readdir(directory, { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries) {
    if (["node_modules", ".git", ".openpond"].includes(entry.name) || entry.name.startsWith(".env")) continue;
    const absolute = path.join(directory, entry.name);
    if (entry.isSymbolicLink()) throw new Error(`Harness source cannot contain symlinks: ${path.relative(root, absolute)}`);
    if (entry.isDirectory()) files.push(...(await listRegularFiles(root, absolute)));
    else if (entry.isFile()) files.push(path.relative(root, absolute).split(path.sep).join("/"));
    else throw new Error(`Harness source contains an unsupported entry: ${path.relative(root, absolute)}`);
  }
  return files.sort();
}

export function safeSegment(value: string): string {
  const result = value.toLowerCase().replace(/[^a-z0-9_-]+/g, "-").replace(/^-+|-+$/g, "");
  return result.slice(0, 48) || "harness";
}
