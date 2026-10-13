import { inlineErrorMessage } from "../../../lib/error-messages";
import type { z } from "zod";
import { useQuery } from "@tanstack/react-query";
import { LocalExperimentRecordPageSchema } from "@openpond/contracts";
import { localRequest } from "./local-workspace-api";
import { ExperimentCollectionTable } from "./ExperimentCollectionTable";
import { localExperimentRecord } from "./experiment-collection-record";
import type { WorkspaceApi } from "./workspace-api";
import type { ModelsRoute } from "../models-route";
type LocalExperimentRecordPage = z.infer<typeof LocalExperimentRecordPageSchema>;
export function LocalExperimentCollection({ api, route, navigate, datasetHash }: {
  api: WorkspaceApi; route: ModelsRoute; navigate: (route: ModelsRoute) => void; datasetHash?: string;
}) {
  const query = useQuery<LocalExperimentRecordPage>({ queryKey: ["local-experiments", api.key, "list", route.after, datasetHash, route.query],
    enabled: Boolean(datasetHash) || !route.resourceId,
    refetchInterval: query => query.state.data?.items.some(item => ["queued", "running", "cancelling"].includes(item.status)) ? 2000 : false,
    queryFn: ({ signal }) => localRequest(api, LocalExperimentRecordPageSchema, "list", {
      ...(api.projectId ? { projectId: api.projectId } : {}), ...(datasetHash ? { datasetHash } : {}),
      ...(route.query ? { search: route.query } : {}), ...(route.after ? { afterId: route.after } : {}),
    }, signal),
  });
  return <>{query.error && inlineErrorMessage(query.error) ? <p role="alert">{query.error.message} <button className="training-text-button" onClick={() => void query.refetch()}>Retry Desktop</button></p> : null}
    <ExperimentCollectionTable rows={(query.data?.items ?? []).map(item => localExperimentRecord(api, item))} loading={query.isPending} route={route} navigate={navigate} />
    {query.data?.nextCursor ? <button className="training-button secondary evaluation-more" onClick={() => navigate({ ...route, after: query.data!.nextCursor })}>More experiments</button> : null}</>;
}
