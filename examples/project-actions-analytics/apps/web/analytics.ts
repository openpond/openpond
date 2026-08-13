import { getAnalyticsSummary } from "../../packages/domain/analytics.js";

export function loadAnalyticsDashboard(businessId: string) {
  return getAnalyticsSummary(businessId);
}
