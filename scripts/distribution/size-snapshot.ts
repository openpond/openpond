import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { gzipSync } from "node:zlib";
import type { PackedFile } from "./package-policy.ts";

const exec = promisify(execFile);
export type SizeSnapshot = {
  schemaVersion: 1;
  revision: string;
  nodeVersion: string;
  npmVersion: string;
  metrics: { packed: number; unpacked: number; rendererJs: number; initialAssets: number };
  files: Array<PackedFile & { gzip: number }>;
};

export async function collectSizeSnapshot(root: string): Promise<SizeSnapshot> {
  const cliRoot = path.join(root, "apps/cli");
  const [{ stdout: packed }, { stdout: revision }, { stdout: npmVersion }] = await Promise.all([
    exec("npm", ["pack", "--dry-run", "--json", "--ignore-scripts"], { cwd: cliRoot, maxBuffer: 16 * 1024 * 1024 }),
    exec("git", ["rev-parse", "HEAD"], { cwd: root }),
    exec("npm", ["--version"], { cwd: root }),
  ]);
  const pack = JSON.parse(packed)[0] as { size: number; unpackedSize: number; files: PackedFile[] };
  const files = await Promise.all(pack.files.map(async (file) => ({
    ...file,
    gzip: gzipSync(await readFile(path.join(cliRoot, file.path))).byteLength,
  })));
  const html = await readFile(path.join(cliRoot, "dist/web/index.html"), "utf8");
  const initial = new Set([...html.matchAll(/(?:src|href)="([^"]+)"/g)]
    .map((match) => match[1]!.replace(/^\.\//, "").replace(/^\//, ""))
    .filter((name) => name.startsWith("assets/"))
    .map((name) => `dist/web/${name}`));
  for (const name of initial) {
    if (!files.some((file) => file.path === name)) throw new Error(`Missing initial asset: ${name}`);
  }
  return {
    schemaVersion: 1,
    revision: revision.trim(),
    nodeVersion: process.version,
    npmVersion: npmVersion.trim(),
    metrics: {
      packed: pack.size,
      unpacked: pack.unpackedSize,
      rendererJs: files.filter((file) => file.path.startsWith("dist/web/") && file.path.endsWith(".js")).reduce((sum, file) => sum + file.size, 0),
      initialAssets: files.filter((file) => initial.has(file.path)).reduce((sum, file) => sum + file.size, 0),
    },
    files: files.sort((left, right) => left.path.localeCompare(right.path)),
  };
}

export async function readSizeSnapshot(filename: string): Promise<SizeSnapshot> {
  const value = JSON.parse(await readFile(filename, "utf8")) as SizeSnapshot;
  const bytes = (n: unknown) => typeof n === "number" && Number.isSafeInteger(n) && n >= 0;
  if (value.schemaVersion !== 1 || !/^[a-f0-9]{40}$/.test(value.revision)
    || typeof value.nodeVersion !== "string" || typeof value.npmVersion !== "string"
    || !value.metrics || !["packed", "unpacked", "rendererJs", "initialAssets"].every((key) => bytes(value.metrics[key as keyof SizeSnapshot["metrics"]]))
    || !Array.isArray(value.files) || !value.files.every((file) => typeof file.path === "string" && bytes(file.size) && bytes(file.gzip))) {
    throw new Error(`Invalid size snapshot: ${filename}`);
  }
  return value;
}
