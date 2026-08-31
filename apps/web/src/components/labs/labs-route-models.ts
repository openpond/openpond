import type { TrainingStateResponse } from "@openpond/contracts";

import type { LabPrimaryTab } from "./LabsView";
import type { ModelSection } from "./lab-primary-tab-state";

export function labTabForModelsSection(
  section: ModelSection,
): LabPrimaryTab {
  if (section === "runs") return "training";
  if (section === "evals") return "evals";
  return section;
}

export function modelsSectionForLabTab(tab: LabPrimaryTab): ModelSection {
  if (tab === "training") return "runs";
  return tab;
}

export function libraryResourceLabel(
  section: "projects" | "tasksets" | "scoring" | "evaluations" | "reviews",
  resourceId: string | null,
  state: TrainingStateResponse | null,
): string | null {
  if (!resourceId) return null;
  if (section === "projects") {
    return state?.modelProjects.find((project) => project.id === resourceId)?.name ?? resourceId;
  }
  if (section === "tasksets" || section === "reviews") {
    return [...(state?.tasksets ?? []), ...(state?.modelTasksets ?? [])].find(
      (taskset) => taskset.id === resourceId,
    )?.name ?? resourceId;
  }
  if (section === "evaluations") {
    return state?.modelRuns.find((run) => run.id === resourceId)?.evaluation
      ?.benchmarkId ?? resourceId;
  }
  for (const taskset of [
    ...(state?.tasksets ?? []),
    ...(state?.modelTasksets ?? []),
  ]) {
    const grader = taskset.graders.find(
      (candidate) => `${candidate.id}@${candidate.version}` === resourceId,
    );
    if (grader) return grader.label;
  }
  return resourceId;
}

export function titleCaseLabel(value: string): string {
  return value
    .replaceAll("_", " ")
    .replace(/\b\w/g, (letter) => letter.toUpperCase());
}

export function modelEntryKeyFromRoute(
  resourceId: string | null,
): string | null {
  if (!resourceId || resourceId.includes(":")) return resourceId;
  const separator = resourceId.indexOf(".");
  if (separator < 0) return resourceId;
  return `${resourceId.slice(0, separator)}:${resourceId.slice(separator + 1)}`;
}

export function modelEntryRouteId(entryKey: string | null): string | null {
  if (!entryKey) return null;
  const separator = entryKey.indexOf(":");
  if (separator < 0) return entryKey;
  return `${entryKey.slice(0, separator)}.${entryKey.slice(separator + 1)}`;
}
