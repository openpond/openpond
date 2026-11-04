import { useEffect, useMemo, useRef } from "react";
import type { ClientConnection } from "../../api";
import { LabHostedTrainingRunDetail } from "./LabHostedTrainingRunDetail";
import { createWorkspaceApi } from "./workspace/workspace-api";
import { modelsLocation, navigateModelsRoute } from "./lab-primary-tab-state";
import { connectionQueryScope } from "../../lib/query-scope";

export function HostedTrainingRunRoute({ connection, teamId, actorId, projectId, accountKey, jobId, loadModel, onOpenExperiment, diagnostics, onDiagnostics }: {
  connection: ClientConnection; teamId: string; actorId: string; projectId: string | null; accountKey: string; jobId: string;
  loadModel(id: string): Promise<string | null>; onOpenExperiment(id: string): void; diagnostics?: boolean; onDiagnostics?(value: boolean): void;
}) {
  const api = useMemo(() => createWorkspaceApi(connection, { teamId, actorId, projectId, accountKey }), [connection, teamId, actorId, projectId, accountKey]);
  const scope = JSON.stringify([api.key, connectionQueryScope(connection), jobId]);
  const current = useRef(scope); current.current = scope;
  useEffect(() => { current.current = scope; return () => { current.current = "unmounted"; }; }, [scope]);
  async function openModel(id: string) {
    const loaded = await loadModel(id);
    if (loaded && current.current === scope) await navigateModelsRoute(modelsLocation("models", loaded));
  }
  return <LabHostedTrainingRunDetail connection={connection} teamId={teamId} actorId={actorId} jobId={jobId} api={api}
    onOpenModel={openModel} retainOperation={api.operation} onOpenExperiment={onOpenExperiment} diagnostics={diagnostics} onDiagnostics={onDiagnostics} />;
}
