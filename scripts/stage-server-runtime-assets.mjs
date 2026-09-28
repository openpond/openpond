import { access, cp, rm } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const source = path.join(root, "apps", "cli", "skills");
const target = path.join(root, "apps", "server", "dist", "skills");
const required = [
  "openpond-taskset-authoring",
  "openpond-skill-authoring",
  "openpond-agent-authoring",
  "openpond-refiner-authoring",
];

for (const name of required) {
  await access(path.join(source, name, "SKILL.md"));
}
await rm(target, { recursive: true, force: true });
await cp(source, target, { recursive: true });
for (const name of required) {
  await access(path.join(target, name, "SKILL.md"));
}
await access(path.join(target, "openpond-taskset-authoring", "artifact.json"));

console.log(`Staged OpenPond server skills at ${path.relative(root, target)}.`);
