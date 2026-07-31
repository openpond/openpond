import type { LabPrimaryTab } from "./LabsView";

const LAB_TAB_QUERY_KEY = "modelsTab";
const LAB_PRIMARY_TABS = new Set<LabPrimaryTab>([
  "models",
  "tasksets",
  "serving",
  "usage",
]);

export function labPrimaryTabFromSearch(search: string): LabPrimaryTab {
  const value = new URLSearchParams(search).get(LAB_TAB_QUERY_KEY);
  return value && LAB_PRIMARY_TABS.has(value as LabPrimaryTab)
    ? (value as LabPrimaryTab)
    : "models";
}

export function searchWithLabPrimaryTab(
  search: string,
  tab: LabPrimaryTab,
): string {
  const params = new URLSearchParams(search);
  if (tab === "models") {
    params.delete(LAB_TAB_QUERY_KEY);
  } else {
    params.set(LAB_TAB_QUERY_KEY, tab);
  }
  const serialized = params.toString();
  return serialized ? `?${serialized}` : "";
}
