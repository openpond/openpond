import { BUILT_IN_OPENPOND_PROFILE_SKILLS, type OpenPondProfileSkill } from "@openpond/contracts";
import { readSkillSourceFile } from "../codex-personal-skills.js";
import { loadTasksetAuthoringProfileSkill } from "../training/task-authoring-skill.js";
import {
  isBundledAuthoringSkillName,
  loadBundledAuthoringProfileSkill,
} from "./bundled-authoring-skills.js";

export async function loadBuiltInSkill(
  name: string,
  repoRoot = process.cwd(),
): Promise<OpenPondProfileSkill> {
  if (name === "openpond-taskset-authoring") return loadTasksetAuthoringProfileSkill(repoRoot);
  if (isBundledAuthoringSkillName(name)) return loadBundledAuthoringProfileSkill(name, repoRoot);
  throw new Error("Unknown built-in OpenPond skill.");
}

/** Inspect the delivered files; a metadata declaration alone is not readiness. */
export async function loadBuiltInSkillCatalog(
  repoRoot = process.cwd(),
): Promise<OpenPondProfileSkill[]> {
  return Promise.all(
    BUILT_IN_OPENPOND_PROFILE_SKILLS.map(async (metadata) => {
      try {
        const skill = await loadBuiltInSkill(metadata.name, repoRoot);
        await Promise.all(
          ["SKILL.md", ...skill.resourceFiles].map((relativeFilePath) =>
            readSkillSourceFile({
              skillName: skill.name,
              scope: "builtin",
              packageRoot: skill.sourcePath,
              relativeFilePath,
            }),
          ),
        );
        return skill;
      } catch {
        return {
          ...metadata,
          enabled: false,
          charCount: 0,
          sourceHash: "",
          validationStatus: "error" as const,
          validationMessages: [
            "This build is missing a complete built-in skill package. Update or repair the Desktop installation.",
          ],
          resourceFiles: [...metadata.resourceFiles],
        };
      }
    }),
  );
}
