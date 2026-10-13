import { UnifiedExperimentCollection } from "./UnifiedExperimentCollection";
import type { ModelsRoute } from "../models-route";
import type { WorkspaceApi } from "./workspace-api";
export function DatasetExperiments({ api, releaseHash, route, navigate }: {
  api: WorkspaceApi; releaseHash: string | null; route: ModelsRoute; navigate: (route: ModelsRoute) => void;
}) {
  return releaseHash ? <UnifiedExperimentCollection api={api} route={route} navigate={navigate} datasetHash={releaseHash} />
    : <p>Publish this Dataset to view its Experiment associations.</p>;
}
