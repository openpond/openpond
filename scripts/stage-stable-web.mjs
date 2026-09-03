import { cp, mkdir, rm, stat } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const source = path.join(root, "apps", "web", "dist");
const target = path.join(root, ".openpond", "stable-web", "build");

const index = await stat(path.join(source, "index.html")).catch(() => null);
if (!index?.isFile()) {
  throw new Error("Stable web staging requires a completed `pnpm build:web`.");
}

await rm(target, { recursive: true, force: true });
await mkdir(path.dirname(target), { recursive: true });
await cp(source, target, { recursive: true });

console.log(`Staged stable web build at ${path.relative(root, target)}.`);
