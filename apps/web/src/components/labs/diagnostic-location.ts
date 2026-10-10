import { modelsRouteFromLocation } from "./models-route";

/** Preserve bounded evidence selection only on an actual diagnostics route. */
export function diagnosticLocationHash(input: { pathname: string; search?: string; hash?: string }): string {
  const route = modelsRouteFromLocation(input);
  if (!route?.resourceId || route.detailTab !== "diagnostics" || !["experiments", "runs"].includes(route.page)) return "";
  const hash = input.hash?.replace(/^#/, "") ?? "";
  if (!hash || hash.length > 2000) return "";
  const selection = new URLSearchParams(hash);
  if ([...selection.keys()].some(key => !["diagnostic-task", "diagnostic-attempt", "event"].includes(key)
    || selection.getAll(key).length !== 1 || !selection.get(key) || selection.get(key)!.length > 500)) return "";
  const attempt = selection.get("diagnostic-attempt");
  if (attempt && !/^[1-9]\d{0,8}$/.test(attempt)) return "";
  return `#${selection}`;
}
