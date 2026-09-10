import { QueryClient } from "@tanstack/react-query";

export function createWorkspaceQueryClient() {
  return new QueryClient({ defaultOptions: { queries: { staleTime: 60_000, gcTime: 15 * 60_000, retry: 1, refetchOnWindowFocus: false } } });
}
