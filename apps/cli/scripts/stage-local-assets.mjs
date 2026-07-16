import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const cliRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const root = path.resolve(cliRoot, "../..");
const webSource = path.join(root, "apps", "web", "dist");
const webTarget = path.join(cliRoot, "dist", "web");
const skillsSource = path.join(cliRoot, "skills");
const skillsTarget = path.join(cliRoot, "dist", "skills");

try {
  await fs.access(path.join(webSource, "index.html"));
} catch {
  throw new Error("The local CLI companion requires apps/web/dist. Run `pnpm build:web` before packaging the CLI.");
}

await Promise.all([
  fs.rm(webTarget, { recursive: true, force: true }),
  fs.rm(skillsTarget, { recursive: true, force: true }),
]);
await Promise.all([
  fs.cp(webSource, webTarget, { recursive: true }),
  fs.cp(skillsSource, skillsTarget, { recursive: true }),
]);
console.log(
  `Staged local CLI assets at ${path.relative(root, webTarget)} and ${path.relative(root, skillsTarget)}.`,
);
