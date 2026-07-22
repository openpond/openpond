import type { SkillSourceScope } from "@openpond/contracts";

export type SkillPackageSourceSelection = {
  name: string;
  description: string;
  scope: SkillSourceScope;
  packagePath: string;
  files: string[];
};
