import { access, readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  BUILT_IN_OPENPOND_PROFILE_SKILLS,
  type OpenPondProfileSkill,
} from "@openpond/contracts";
import type { ProfileSkillReadResult } from "../openpond/model-tool-registry.js";

const SKILL_DIRECTORY = "openpond-taskset-authoring";
const SKILL_ARTIFACT_FILE = "artifact.json";
const moduleDirectory = path.dirname(fileURLToPath(import.meta.url));

export type TasksetAuthoringSkillArtifact = {
  schemaVersion: 1;
  artifactVersion: string;
  skillName: typeof SKILL_DIRECTORY;
  source: {
    repository: "openpond/openpond";
    commit: string;
    path: string;
  };
  files: Array<{ path: string; sha256: string; contents: string }>;
  bundle: string;
  contentHash: string;
};

export async function loadTasksetAuthoringSkillBundle(repoRoot = process.cwd()): Promise<string> {
  return (await loadTasksetAuthoringSkillArtifact(repoRoot)).bundle;
}

export async function loadTasksetAuthoringSkillArtifact(
  repoRoot = process.cwd(),
): Promise<TasksetAuthoringSkillArtifact> {
  const skillRoot = await resolveTasksetAuthoringSkillRoot(repoRoot);
  const parsed = JSON.parse(
    await readFile(path.join(skillRoot, SKILL_ARTIFACT_FILE), "utf8"),
  ) as TasksetAuthoringSkillArtifact;
  if (
    parsed.schemaVersion !== 1 ||
    parsed.skillName !== SKILL_DIRECTORY ||
    !parsed.artifactVersion ||
    !parsed.bundle ||
    !/^[a-f0-9]{64}$/.test(parsed.contentHash)
  ) {
    throw new Error("Bundled Taskset Authoring artifact is invalid.");
  }
  const { contentHash, ...core } = parsed;
  const actualHash = createHash("sha256")
    .update(JSON.stringify(core))
    .digest("hex");
  if (actualHash !== contentHash) {
    throw new Error("Bundled Taskset Authoring artifact hash does not match.");
  }
  for (const file of parsed.files) {
    if (
      createHash("sha256").update(file.contents).digest("hex") !== file.sha256
    ) {
      throw new Error(
        `Bundled Taskset Authoring file hash does not match: ${file.path}`,
      );
    }
  }
  return parsed;
}

export async function loadTasksetAuthoringProfileSkill(
  repoRoot = process.cwd(),
): Promise<OpenPondProfileSkill> {
  const root = await resolveTasksetAuthoringSkillRoot(repoRoot);
  const artifact = await loadTasksetAuthoringSkillArtifact(repoRoot);
  const body = artifact.bundle;
  const builtIn = BUILT_IN_OPENPOND_PROFILE_SKILLS[0];
  return {
    ...builtIn,
    path: path.join(root, "SKILL.md"),
    sourcePath: root,
    charCount: body.length,
    sourceHash: artifact.contentHash,
    validationMessages: [...builtIn.validationMessages],
    resourceFiles: [...builtIn.resourceFiles],
  };
}

export async function readTasksetAuthoringProfileSkill(
  repoRoot = process.cwd(),
): Promise<ProfileSkillReadResult> {
  const skill = await loadTasksetAuthoringProfileSkill(repoRoot);
  const body = await loadTasksetAuthoringSkillBundle(repoRoot);
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
    if (
      await access(path.join(candidate, SKILL_ARTIFACT_FILE)).then(
        () => true,
        () => false,
      )
    ) {
      return candidate;
    }
  }
  throw new Error(`Bundled Taskset Authoring skill was not found. Checked: ${candidates.join(", ")}`);
}
