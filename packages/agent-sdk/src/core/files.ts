import { existsSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

export async function writeJson(cwd: string, relativePath: string, value: unknown) {
  await writeText(cwd, relativePath, `${JSON.stringify(value, null, 2)}\n`);
}

export async function writeText(cwd: string, relativePath: string, value: string) {
  const target = path.join(cwd, relativePath);
  await mkdir(path.dirname(target), { recursive: true });
  await writeFile(target, value, "utf8");
}

export function pathExists(filePath: string): boolean {
  return existsSync(filePath);
}
