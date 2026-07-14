import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const workflowDirectory = path.join(root, ".github", "workflows");
const immutableRef = /^[0-9a-f]{40}$/;
const usePattern = /^\s*(?:-\s*)?uses:\s*([^\s#]+)(?:\s+#\s*(.+))?\s*$/;
const errors: string[] = [];

for (const name of (await fs.readdir(workflowDirectory)).sort()) {
  if (!/\.ya?ml$/.test(name)) continue;
  const file = path.join(workflowDirectory, name);
  const lines = (await fs.readFile(file, "utf8")).split("\n");
  for (const [index, line] of lines.entries()) {
    const match = line.match(usePattern);
    if (!match) continue;
    const target = match[1]!;
    if (target.startsWith("./") || target.startsWith("docker://")) continue;
    const separator = target.lastIndexOf("@");
    const reference = separator === -1 ? "" : target.slice(separator + 1);
    if (!immutableRef.test(reference)) {
      errors.push(`${name}:${index + 1} external action uses mutable ref ${target}`);
    }
    if (!match[2]?.trim()) {
      errors.push(`${name}:${index + 1} pinned action ${target} needs a readable version comment`);
    }
  }
}

if (errors.length > 0) {
  for (const error of errors) console.error(`[workflow-check] ${error}`);
  process.exitCode = 1;
} else {
  console.log("Workflow reference check passed: every external action is SHA-pinned and version-labelled.");
}
