import { useQueryClient } from "@tanstack/react-query";
import { UnifiedExperimentCollection } from "./UnifiedExperimentCollection";
import { RecordedExperimentCollection } from "./RecordedExperimentCollection";
import { useWorkspaceActions, useWorkspaceResourceName } from "./WorkspacePanel";
import { useEvaluationSetup } from "./EvaluationSetupState";
import { workspaceApiForLocation, type WorkspaceApi } from "./workspace-api";
import { useMemo } from "react";
import type { ModelsRoute } from "../models-route";
export function UnifiedExperimentsPage({ api, route, navigate }: { api: WorkspaceApi; route: ModelsRoute; navigate: (route: ModelsRoute) => void }) {
  const setup = useEvaluationSetup(), queries = useQueryClient();
  const hostedApi = useMemo(() => workspaceApiForLocation(api, "hosted"), [api]);
  const select = useWorkspaceActions([{ id: "experiment", label: "Experiment", onSelect: () => setup.open(null, null, { ...route, executionLocation: "local" }) }]);
  useWorkspaceResourceName(null);
  return <>
    <header className="evaluation-workspace-header"><h1>Experiments</h1><input aria-label="Search experiments" placeholder="Search experiments" value={route.query}
      onChange={event => navigate({ ...route, query: event.target.value, after: null })} />
      <button className="training-button secondary" onClick={() => void queries.invalidateQueries({ queryKey: ["unified-experiments"] })}>Refresh</button>
      <button className="training-button" onClick={() => select("experiment")}>Run experiment</button></header>
    <UnifiedExperimentCollection api={api} route={route} navigate={navigate} />
    <RecordedExperimentCollection api={hostedApi} route={route} navigate={navigate} />
  </>;
}
