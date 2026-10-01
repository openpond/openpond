import { useEffect } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { OpenPondDatasetMarketplaceClient } from "openpond-sdk/dataset-marketplace";
import type { DatasetWorkspaceReceipt } from "openpond-sdk/dataset-workspaces";
import type { WorkspaceApi } from "./workspace-api";
type Visibility = Awaited<ReturnType<OpenPondDatasetMarketplaceClient["visibility"]>>;
export function useDatasetVisibilityMenu(
  api: WorkspaceApi,
  publication: DatasetWorkspaceReceipt["publication"],
  onPrepare: () => void,
) {
  const cache = useQueryClient(),
    queryKey = ["evaluation-workspace", api.key, "marketplaceVisibility", publication?.tasksetId];
  const query = useQuery({
    queryKey,
    enabled: Boolean(publication),
    queryFn: ({ signal }) =>
      api.request<Visibility>("marketplaceVisibility", { id: publication!.tasksetId }, signal),
  });
  const mutation = useMutation({
    mutationFn: async (change: {
      api: WorkspaceApi;
      queryKey: typeof queryKey;
      request: {
        releaseId: string;
        expectedVisibilityRevision: number;
        visibility: "public" | "private";
      };
    }) => {
      const operation = await change.api.operation("marketplaceChangeVisibility", change.request);
      await change.api.request("marketplaceChangeVisibility", {
        ...change.request,
        operationId: operation.id,
      });
      await operation.acknowledge();
    },
    onSuccess: (_result, change) => void cache.invalidateQueries({ queryKey: change.queryKey }),
    onError: (_error, change) => void cache.invalidateQueries({ queryKey: change.queryKey }),
  });
  const reset = mutation.reset;
  useEffect(() => reset(), [api.key, publication?.tasksetId, reset]);
  return {
    checked: query.data?.visibility === "public",
    disabled: query.isPending || query.isFetching || mutation.isPending || !query.data,
    error: mutation.error?.message ?? query.error?.message,
    change: (checked: boolean) => {
      if (!query.data?.summary) {
        if (checked) onPrepare();
        return;
      }
      mutation.mutate({
        api,
        queryKey,
        request: {
          releaseId: query.data.summary.id,
          expectedVisibilityRevision: query.data.visibilityRevision,
          visibility: checked ? "public" : "private",
        },
      });
    },
  };
}
