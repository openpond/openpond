import type { SkillSourceScope } from "@openpond/contracts";

import type { LabWorkproductSummary } from "./lab-workproducts";

export type LabSkillSourceSelection = {
  name: string;
  description: string;
  scope: SkillSourceScope;
  packagePath: string;
  files: string[];
};

export function labSkillSourceSelection(
  workproduct: LabWorkproductSummary | null,
): LabSkillSourceSelection | null {
  if (workproduct?.kind !== "skill" || !workproduct.skillSource) return null;
  return {
    name: workproduct.name,
    description: workproduct.description,
    scope: workproduct.skillSource,
    packagePath: workproduct.path ?? workproduct.name,
    files: [
      "SKILL.md",
      ...new Set(workproduct.skillResourceFiles ?? []),
    ],
  };
}
