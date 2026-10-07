import { useQuery } from "@tanstack/react-query";
import type { PlanUsageProvider, ProviderPlanUsage } from "@openpond/contracts";
import { apiFetch, type ClientConnection } from "../api/api-client";
import { connectionQueryScope } from "../lib/query-scope";

export function useProviderPlanUsage(connection: ClientConnection | null, provider: PlanUsageProvider) {
  return useQuery({
    queryKey: ["provider-plan-usage", connectionQueryScope(connection), provider],
    enabled: Boolean(connection),
    queryFn: ({ signal }) => apiFetch<ProviderPlanUsage>(connection!, `/v1/providers/${provider}/plan-usage`, { signal: AbortSignal.any([signal, AbortSignal.timeout(25_000)]) }),
    staleTime: 30_000,
    refetchInterval: 60_000,
    refetchOnWindowFocus: "always",
    retry: false,
    gcTime: 300_000,
  });
}
