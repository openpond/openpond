import type { PlanUsageProvider, ProviderPlanUsage } from "@openpond/contracts";

export function primaryPlanUsageWindow(provider: PlanUsageProvider, usage: ProviderPlanUsage | undefined) {
  if (usage?.status !== "ready") return undefined;
  return usage.windows.find(window => window.shared && (provider === "claude-code" ? window.id === "five_hour" : window.label === "Weekly"));
}

export function planUsageIsStale(usage: ProviderPlanUsage | undefined, now = Date.now()) {
  return Boolean(usage && (usage.message || Date.parse(usage.refreshAfter) + 60_000 < now ||
    usage.windows.some(window => window.resetsAt && Date.parse(window.resetsAt) <= now)));
}
