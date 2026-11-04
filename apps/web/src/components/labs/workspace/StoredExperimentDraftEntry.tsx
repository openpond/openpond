import { useEffect, useRef } from "react";
import { useQuery } from "@tanstack/react-query";
import { ErrorToast } from "../../common/ErrorToast";
import { experimentDraftApi } from "./experiment-draft-api";
import { useEvaluationSetup } from "./EvaluationSetupState";
import { useWorkspacePanelControls } from "./WorkspacePanel";
import type { WorkspaceApi } from "./workspace-api";
import type { ModelsRoute } from "../models-route";

/** The URL names an authoring document, never an execution. Refresh reads the
 * canonical record; background revalidation must not replace an open editor. */
export function StoredExperimentDraftEntry({ api, route }: { api: WorkspaceApi; route: ModelsRoute }) {
  const setup = useEvaluationSetup(), controls = useWorkspacePanelControls();
  const opened = useRef<string | null>(null);
  const id = route.resourceId!;
  const query = useQuery({
    queryKey: ["experiment-draft", api.connection.serverUrl, api.accountKey, api.actorId, api.teamId, api.projectId, id],
    queryFn: ({ signal }) => experimentDraftApi(api, signal).get(id),
  });
  const record = query.data;
  useEffect(() => {
    if (!record || query.isFetching || opened.current === record.id) return;
    opened.current = record.id;
    if (setup.initialExperiment?.id === record.id && setup.draft) return;
    setup.openStored(record, route);
    controls?.select({ id: "experiment", label: "Experiment", onSelect: () => {} });
  }, [record, query.isFetching, route, setup, controls]);
  return <>
    {query.isPending ? <p role="status">Loading experiment draft…</p> : null}
    {query.error ? <ErrorToast error={query.error}>
      <button type="button" className="training-button secondary" onClick={() => void query.refetch()}>Retry draft</button>
    </ErrorToast> : null}
  </>;
}
