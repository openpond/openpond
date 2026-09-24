import { readFile, readdir } from "node:fs/promises";
import path from "node:path";

const MiB = 1024 * 1024;
// Product-level safety ceilings, not per-feature allowances. Review these only
// when the distribution's intended scope changes; PR growth is reported separately.
export const PACKAGE_BUDGETS = { packedBytes: 16 * MiB, unpackedBytes: 64 * MiB, files: 1_000 };
export const MAX_RENDERER_JS_BYTES = 32 * MiB;
export type PackedFile = { path: string; size: number };

export function packageContentErrors(files: PackedFile[], runtimeOutputs: string[]): string[] {
  const errors: string[] = [];
  const actual = new Set(files.map((file) => file.path));
  const expectedRuntime = new Set(runtimeOutputs);
  for (const { path: name } of files) {
    const allowed = /^(?:package\.json|LICENSE|README\.md|CHANGELOG\.md|RELEASE\.md)$/.test(name)
      || name.startsWith("docs/") || name.startsWith("dist/");
    const forbidden = /(?:^|\/)(?:node_modules|__tests__|__fixtures__|fixtures|coverage|\.git)(?:\/|$)/.test(name)
      || /\.(?:map|tsbuildinfo|tgz|mp4)$/.test(name)
      || /\.(?:test|spec)\.[cm]?[jt]sx?$/.test(name)
      || (/\.[cm]?tsx?$/.test(name) && !/\.d\.[cm]?ts$/.test(name));
    if (!allowed || forbidden) errors.push(`Unintended package file: ${name}`);
    if (name.startsWith("dist/") && !name.startsWith("dist/web/") && !name.startsWith("dist/skills/")
      && /\.[cm]?js$/.test(name) && !expectedRuntime.has(name)) {
      errors.push(`Stale or untracked runtime output: ${name}`);
    }
  }
  for (const name of expectedRuntime) {
    if (!actual.has(name)) errors.push(`Missing runtime output: ${name}`);
  }
  return errors;
}

export async function checkPackageContents(root: string, files: PackedFile[]): Promise<void> {
  const inventoryPath = path.join(root, "apps/cli/build/runtime-outputs.json");
  const inventory: unknown = JSON.parse(await readFile(inventoryPath, "utf8"));
  if (!Array.isArray(inventory) || !inventory.length || !inventory.every((name) => typeof name === "string" && name.startsWith("dist/"))) {
    throw new Error(`Invalid runtime inventory: ${inventoryPath}; rebuild the CLI.`);
  }
  const errors = packageContentErrors(files, inventory);
  // The web build is cleaned by Vite. The npm copy must contain exactly that
  // build, so an old hashed asset left behind by staging cannot quietly ship.
  const webFiles = await listFiles(path.join(root, "apps/web/dist"));
  const expectedWeb = new Set(webFiles.map((name) => `dist/web/${name}`));
  const actualWeb = new Set(files.filter((file) => file.path.startsWith("dist/web/")).map((file) => file.path));
  for (const name of actualWeb) if (!expectedWeb.has(name)) errors.push(`Stale web output: ${name}`);
  for (const name of expectedWeb) if (!actualWeb.has(name)) errors.push(`Missing web output: ${name}`);
  if (errors.length) throw new Error(`Package contents check failed:\n${errors.join("\n")}`);
}

export async function listFiles(root: string, prefix = ""): Promise<string[]> {
  const entries = await readdir(path.join(root, prefix), { withFileTypes: true });
  return (await Promise.all(entries.map(async (entry) => {
    const name = prefix ? `${prefix}/${entry.name}` : entry.name;
    return entry.isDirectory() ? listFiles(root, name) : [name];
  }))).flat().sort();
}
