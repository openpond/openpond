import type { OpenPondExtension } from "@openpond/contracts";

import type { SkillPackageSourceSelection } from "../app-shell/skill-package-source";

export function extensionSourceSelection(extension: OpenPondExtension): SkillPackageSourceSelection {
  const files = new Set<string>();
  if (extension.readmePath) {
    const readmeName = extension.readmePath.replaceAll("\\", "/").split("/").at(-1);
    if (readmeName) files.add(readmeName);
  }
  for (const skill of extension.skills) {
    files.add(skill.relativePath);
    const separator = skill.relativePath.lastIndexOf("/");
    const skillRoot = separator >= 0 ? skill.relativePath.slice(0, separator) : "";
    for (const resourceFile of skill.resourceFiles) {
      files.add(skillRoot ? `${skillRoot}/${resourceFile}` : resourceFile);
    }
  }
  return {
    name: `${extension.owner}/${extension.repo}`,
    description: `${extension.skills.length} installed skill${extension.skills.length === 1 ? "" : "s"} from GitHub.`,
    scope: "extension",
    packagePath: extension.sourcePath,
    files: [...files],
  };
}
