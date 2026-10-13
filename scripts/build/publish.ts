import { randomUUID } from "node:crypto";
import { copyFile, mkdir, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";

export async function publishBuild(source: string, target: string): Promise<void> {
  const stagedFiles = (await filesBelow(source))
    .filter((file) => file !== ".tsbuildinfo")
    .sort(
      (left, right) => publishPriority(left) - publishPriority(right) || left.localeCompare(right),
    );
  const stagedSet = new Set(stagedFiles);
  await mkdir(target, { recursive: true });
  for (const relative of stagedFiles) {
    const destination = path.join(target, relative);
    const previous = await readFile(destination).catch(() => null);
    if (previous?.equals(await readFile(path.join(source, relative)))) continue;
    const temporary = `${destination}.${randomUUID()}.tmp`;
    await mkdir(path.dirname(destination), { recursive: true });
    await copyFile(path.join(source, relative), temporary);
    try {
      await rename(temporary, destination);
    } finally {
      await rm(temporary, { force: true });
    }
  }
  for (const relative of await filesBelow(target)) {
    if (!stagedSet.has(relative)) await rm(path.join(target, relative), { force: true });
  }
}

function publishPriority(relative: string): number {
  if (relative === "index.js") return 3;
  if (relative.endsWith("/index.js")) return 2;
  if (relative === "types/index.d.ts" || relative === "types/index.d.ts.map") return 5;
  if (relative.endsWith("/index.d.ts") || relative.endsWith("/index.d.ts.map")) return 4;
  return 1;
}

async function filesBelow(directory: string, prefix = ""): Promise<string[]> {
  const entries = await readdir(path.join(directory, prefix), { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries) {
    const relative = path.join(prefix, entry.name);
    if (entry.isDirectory()) files.push(...(await filesBelow(directory, relative)));
    else if (entry.isFile()) files.push(relative);
  }
  return files;
}

export async function stageEmit(
  source: string,
  staging: string,
  destination: string,
): Promise<void> {
  for (const file of await filesBelow(source)) {
    if (file === ".tsbuildinfo") continue;
    const target = path.join(staging, file);
    await mkdir(path.dirname(target), { recursive: true });
    if (file.endsWith(".map")) {
      const map = JSON.parse(await readFile(path.join(source, file), "utf8"));
      map.sources = map.sources.map((entry: string) =>
        path
          .relative(
            path.dirname(path.join(destination, file)),
            path.resolve(path.dirname(path.join(source, file)), entry),
          )
          .split(path.sep)
          .join("/"),
      );
      await writeFile(target, JSON.stringify(map));
    } else await copyFile(path.join(source, file), target);
  }
}
