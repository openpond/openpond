import type { LabPrimaryTab } from "./LabsView";

const LAB_TAB_QUERY_KEY = "modelsTab";
const LAB_PROJECT_QUERY_KEY = "modelProjectId";
export const LAB_PRIMARY_TAB_CHANGE_EVENT = "openpond:models-tab-change";
export const LAB_MODEL_PROJECT_CHANGE_EVENT = "openpond:model-project-change";
const LAB_PRIMARY_TABS = new Set<LabPrimaryTab>([
  "overview",
  "tasksets",
  "training",
  "evals",
  "serving",
]);

export function labPrimaryTabFromSearch(search: string): LabPrimaryTab {
  const value = new URLSearchParams(search).get(LAB_TAB_QUERY_KEY);
  if (value === "runs" || value === "rollouts") return "training";
  if (value === "versions") return "overview";
  return value && LAB_PRIMARY_TABS.has(value as LabPrimaryTab)
    ? (value as LabPrimaryTab)
    : "overview";
}

export function searchWithLabPrimaryTab(
  search: string,
  tab: LabPrimaryTab,
): string {
  const params = new URLSearchParams(search);
  if (tab === "overview") {
    params.delete(LAB_TAB_QUERY_KEY);
  } else {
    params.set(LAB_TAB_QUERY_KEY, tab);
  }
  const serialized = params.toString();
  return serialized ? `?${serialized}` : "";
}

export function labModelProjectIdFromSearch(search: string): string | null {
  return new URLSearchParams(search).get(LAB_PROJECT_QUERY_KEY);
}

export function searchWithLabModelProject(
  search: string,
  modelProjectId: string | null,
): string {
  const params = new URLSearchParams(search);
  if (modelProjectId) params.set(LAB_PROJECT_QUERY_KEY, modelProjectId);
  else params.delete(LAB_PROJECT_QUERY_KEY);
  const serialized = params.toString();
  return serialized ? `?${serialized}` : "";
}
