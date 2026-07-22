import type { LabWorkproductSummary } from "./lab-workproducts";
import type { SkillPackageSourceSelection } from "../app-shell/skill-package-source";

export type LabSkillSourceSelection = SkillPackageSourceSelection;

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
