import { access, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const REFERENCE_FILES = [
  "task-design.md",
  "graders-and-rewards.md",
  "method-selection.md",
  "privacy-and-provenance.md",
] as const;

const SKILL_DIRECTORY = "openpond-taskset-authoring";
const moduleDirectory = path.dirname(fileURLToPath(import.meta.url));

export async function loadTasksetAuthoringSkillBundle(repoRoot = process.cwd()): Promise<string> {
  const skillRoot = await resolveTasksetAuthoringSkillRoot(repoRoot);
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

export async function resolveTasksetAuthoringSkillRoot(
  repoRoot = process.cwd(),
  executablePath = process.execPath,
): Promise<string> {
  const candidates = [
    process.env.OPENPOND_TASKSET_AUTHORING_SKILL_ROOT,
    path.resolve(repoRoot, "apps", "cli", "skills", SKILL_DIRECTORY),
    path.resolve(repoRoot, "dist", "skills", SKILL_DIRECTORY),
    path.resolve(path.dirname(executablePath), "skills", SKILL_DIRECTORY),
    path.resolve(moduleDirectory, "skills", SKILL_DIRECTORY),
    path.resolve(moduleDirectory, "..", "skills", SKILL_DIRECTORY),
  ].filter((candidate): candidate is string => Boolean(candidate));
  for (const candidate of candidates) {
    if (await access(path.join(candidate, "SKILL.md")).then(() => true, () => false)) return candidate;
  }
  throw new Error(`Bundled Taskset Authoring skill was not found. Checked: ${candidates.join(", ")}`);
}
