import { createHash } from "node:crypto";
import { access, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  BUILT_IN_OPENPOND_PROFILE_SKILLS,
  type OpenPondProfileSkill,
} from "@openpond/contracts";
import type { ProfileSkillReadResult } from "../openpond/model-tool-registry.js";

export const BUNDLED_AUTHORING_SKILL_NAMES = [
  "openpond-skill-authoring",
  "openpond-agent-authoring",
  "openpond-refiner-authoring",
] as const;

export type BundledAuthoringSkillName = typeof BUNDLED_AUTHORING_SKILL_NAMES[number];

const REFERENCE_FILES: Record<BundledAuthoringSkillName, readonly string[]> = {
  "openpond-skill-authoring": [
    "references/skill-package-layout.md",
    "references/copying-and-adaptation.md",
    "references/validation-and-repair.md",
  ],
  "openpond-agent-authoring": [
    "references/profile-layout.md",
    "references/action-and-chat-design.md",
    "references/integrations-and-setup.md",
    "references/validation-and-repair.md",
  ],
  "openpond-refiner-authoring": [
    "references/review-profile.md",
    "references/core-boundary.md",
    "references/validation-and-activation.md",
  ],
};

const moduleDirectory = path.dirname(fileURLToPath(import.meta.url));

export function isBundledAuthoringSkillName(value: string): value is BundledAuthoringSkillName {
  return BUNDLED_AUTHORING_SKILL_NAMES.includes(value as BundledAuthoringSkillName);
}

export async function loadBundledAuthoringSkills(
  repoRoot = process.cwd(),
): Promise<OpenPondProfileSkill[]> {
  return Promise.all(BUNDLED_AUTHORING_SKILL_NAMES.map((name) =>
    loadBundledAuthoringProfileSkill(name, repoRoot)));
}

export async function loadBundledAuthoringProfileSkill(
  name: BundledAuthoringSkillName,
  repoRoot = process.cwd(),
): Promise<OpenPondProfileSkill> {
  const root = await resolveBundledAuthoringSkillRoot(name, repoRoot);
  const body = await loadBundledAuthoringSkillBundle(name, repoRoot);
  const builtIn = BUILT_IN_OPENPOND_PROFILE_SKILLS.find((skill) => skill.name === name);
  if (!builtIn) throw new Error(`Built-in OpenPond authoring skill metadata not found: ${name}`);
  return {
    ...builtIn,
    path: path.join(root, "SKILL.md"),
    sourcePath: root,
    charCount: body.length,
    sourceHash: createHash("sha256").update(body).digest("hex"),
    validationMessages: [...builtIn.validationMessages],
    resourceFiles: [...builtIn.resourceFiles],
  };
}

export async function readBundledAuthoringProfileSkill(
  name: BundledAuthoringSkillName,
  repoRoot = process.cwd(),
): Promise<ProfileSkillReadResult> {
  const skill = await loadBundledAuthoringProfileSkill(name, repoRoot);
  const body = await loadBundledAuthoringSkillBundle(name, repoRoot);
  return {
    name: skill.name,
    description: skill.description,
    body,
    path: skill.path,
    sourceHash: skill.sourceHash,
    charCount: skill.charCount,
    packagePath: skill.sourcePath,
    resourceFiles: skill.resourceFiles,
  };
}

export async function loadBundledAuthoringSkillBundle(
  name: BundledAuthoringSkillName,
  repoRoot = process.cwd(),
): Promise<string> {
  const root = await resolveBundledAuthoringSkillRoot(name, repoRoot);
  const [skill, ...references] = await Promise.all([
    readFile(path.join(root, "SKILL.md"), "utf8"),
    ...REFERENCE_FILES[name].map((relativePath) => readFile(path.join(root, relativePath), "utf8")),
  ]);
  return [
    skill.trim(),
    ...references.map((reference, index) =>
      `\n## Bundled reference: ${REFERENCE_FILES[name][index]}\n\n${reference.trim()}`),
  ].join("\n");
}

export async function resolveBundledAuthoringSkillRoot(
  name: BundledAuthoringSkillName,
  repoRoot = process.cwd(),
  executablePath = process.execPath,
): Promise<string> {
  const candidates = [
    path.resolve(repoRoot, "apps", "cli", "skills", name),
    path.resolve(repoRoot, "dist", "skills", name),
    path.resolve(path.dirname(executablePath), "skills", name),
    path.resolve(moduleDirectory, "skills", name),
    path.resolve(moduleDirectory, "..", "skills", name),
  ];
  for (const candidate of candidates) {
    if (await access(path.join(candidate, "SKILL.md")).then(() => true, () => false)) return candidate;
  }
  throw new Error(`Bundled OpenPond authoring skill ${name} was not found. Checked: ${candidates.join(", ")}`);
}
