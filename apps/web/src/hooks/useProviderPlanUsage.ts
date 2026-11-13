import { useQuery } from "@tanstack/react-query";
import { createContext, useContext } from "react";
import type { PlanUsageProvider, ProviderPlanUsage } from "@openpond/contracts";
import { apiFetch, type ClientConnection } from "../api/api-client";
import { connectionQueryScope } from "../lib/query-scope";

export const ProviderPlanUsageBootstrapContext = createContext<{
  connection: ClientConnection | null;
  usage: Partial<Record<PlanUsageProvider, ProviderPlanUsage>>;
} | null>(null);

export function useProviderPlanUsage(connection: ClientConnection | null, provider: PlanUsageProvider, options: { poll?: boolean } = {}) {
  const bootstrap = useContext(ProviderPlanUsageBootstrapContext);
  const initial = bootstrap?.connection === connection ? bootstrap.usage[provider] : undefined;
  return useQuery({
    queryKey: ["provider-plan-usage", connectionQueryScope(connection), provider],
    enabled: Boolean(connection),
    initialData: initial,
    initialDataUpdatedAt: initial ? Date.parse(initial.fetchedAt) : undefined,
    queryFn: ({ signal }) => apiFetch<ProviderPlanUsage>(connection!, `/v1/providers/${provider}/plan-usage`, { signal: AbortSignal.any([signal, AbortSignal.timeout(25_000)]) }),
    staleTime: 30_000,
    refetchInterval: options.poll === false ? false : 60_000,
    refetchOnWindowFocus: options.poll === false ? false : "always",
    refetchOnMount: options.poll === false ? false : true,
    retry: false,
    gcTime: 300_000,
  });
}
