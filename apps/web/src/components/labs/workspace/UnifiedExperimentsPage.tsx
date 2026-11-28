import { useQueryClient } from "@tanstack/react-query";
import { UnifiedExperimentCollection } from "./UnifiedExperimentCollection";
import { RecordedExperimentCollection } from "./RecordedExperimentCollection";
import { useWorkspaceActions, useWorkspaceResourceName } from "./WorkspacePanel";
import { workspaceApiForLocation, type WorkspaceApi } from "./workspace-api";
import { useContext, useMemo } from "react";
import type { ModelsRoute } from "../models-route";
import { ModificationRecordingImport } from "./ModificationRecordingImport";
import { DesktopNewContext, DesktopNewResourceButton } from "../../chat/DesktopNewMenu";
export function UnifiedExperimentsPage({ api, route, navigate }: { api: WorkspaceApi; route: ModelsRoute; navigate: (route: ModelsRoute) => void }) {
  const newResource = useContext(DesktopNewContext), queries = useQueryClient();
  const hostedApi = useMemo(() => workspaceApiForLocation(api, "hosted"), [api]);
  const localApi = useMemo(() => workspaceApiForLocation(api, "local"), [api]);
  useWorkspaceActions(newResource && !newResource.busy ? [{ id: "experiment", label: "Benchmark", onSelect: () => newResource.create("benchmark") }] : []);
  useWorkspaceResourceName(null);
  return <>
    <header className="evaluation-workspace-header"><h1>Benchmarks</h1><input aria-label="Search benchmarks" placeholder="Search benchmarks" value={route.query}
      onChange={event => navigate({ ...route, query: event.target.value, after: null })} />
      <button className="training-button secondary" onClick={() => void queries.invalidateQueries({ queryKey: ["unified-experiments"] })}>Refresh</button>
      {api.actorId ? <ModificationRecordingImport key={localApi.key} api={localApi} onOpen={id => navigate({ ...route,
        executionLocation: "local", resourceId: `modification-recording:${id}`, collection: "default", detailTab: null, after: null })} /> : null}
      <DesktopNewResourceButton kind="benchmark" /></header>
    <UnifiedExperimentCollection api={api} route={route} navigate={navigate} />
    <RecordedExperimentCollection api={hostedApi} route={route} navigate={navigate} />
  </>;
}
