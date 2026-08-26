import type { LabPrimaryTab } from "./LabsView";

const LAB_TAB_QUERY_KEY = "modelsTab";
export const LAB_PRIMARY_TAB_CHANGE_EVENT = "openpond:models-tab-change";
const LAB_PRIMARY_TABS = new Set<LabPrimaryTab>([
  "overview",
  "tasksets",
  "versions",
  "runs",
  "rollouts",
  "serving",
]);

export function labPrimaryTabFromSearch(search: string): LabPrimaryTab {
  const value = new URLSearchParams(search).get(LAB_TAB_QUERY_KEY);
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
