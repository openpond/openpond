import { ErrorToast } from "../../common/ErrorToast";
import type { ExperimentRunDetails } from "openpond-sdk/experiments";
import { ExperimentCollectionTable } from "./ExperimentCollectionTable";
import { hostedExperimentRecord } from "./experiment-collection-record";
import type { WorkspaceApi } from "./workspace-api";
import type { ModelsRoute } from "../models-route";
export function HostedExperimentCollection({ api, items, loading, error, retry, route, navigate }: {
  api: WorkspaceApi; items: ExperimentRunDetails[]; loading: boolean; error?: string; retry: () => void;
  route: ModelsRoute; navigate: (route: ModelsRoute) => void;
}) {
  return <>{error ? <ErrorToast error={error}><button className="training-text-button" onClick={retry}>Retry Hosted</button></ErrorToast> : null}
    <ExperimentCollectionTable rows={items.map(item => hostedExperimentRecord(api, item))} loading={loading} route={route} navigate={navigate} /></>;
}
