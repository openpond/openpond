import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const cliRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const root = path.resolve(cliRoot, "../..");
const source = path.join(root, "apps", "web", "dist");
const target = path.join(cliRoot, "dist", "web");

try {
  await fs.access(path.join(source, "index.html"));
} catch {
  throw new Error("The local CLI companion requires apps/web/dist. Run `bun run build:web` before packaging the CLI.");
}

await fs.rm(target, { recursive: true, force: true });
await fs.cp(source, target, { recursive: true });
console.log(`Staged local CLI web companion at ${path.relative(root, target)}.`);
