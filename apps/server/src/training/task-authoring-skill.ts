import { readFile } from "node:fs/promises";
import path from "node:path";

const REFERENCE_FILES = [
  "task-design.md",
  "graders-and-rewards.md",
  "method-selection.md",
  "privacy-and-provenance.md",
] as const;

export async function loadTasksetAuthoringSkillBundle(repoRoot = process.cwd()): Promise<string> {
  const skillRoot = path.resolve(repoRoot, "apps", "cli", "skills", "openpond-taskset-authoring");
  const [skill, ...references] = await Promise.all([
    readFile(path.join(skillRoot, "SKILL.md"), "utf8"),
    ...REFERENCE_FILES.map((name) => readFile(path.join(skillRoot, "references", name), "utf8")),
  ]);
  return [
    skill.trim(),
    ...references.map((reference, index) =>
      `\n## Bundled reference: ${REFERENCE_FILES[index]}\n\n${reference.trim()}`),
  ].join("\n");
}
