import { useMemo, useState, type ReactNode } from "react";
import { useQuery } from "@tanstack/react-query";
import type { ModelProject } from "@openpond/contracts";
import { parseModelNativeRunPage } from "openpond-sdk/model-projects";
import type { ClientConnection } from "../../api";
import { apiFetch } from "../../api/api-client";
import { connectionQueryScope } from "../../lib/query-scope";
import { modelsLocation, type ModelsRoute } from "./models-route";
import { ModelProjectPageHeader } from "./ModelProjectPageHeader";
import { LabStatusBadge } from "./LabStatusBadge";
import { EvaluationTableState } from "./workspace/EvaluationTableState";
import { formatDateTime, statusLabel } from "../training/training-model-data";

/** Training owns attempts; saved versions and serving remain distinct actions. */
export function ModelTrainingWorkspace({ model, connection, accountKey, onNavigate, onNewRun, startingRun = false, children }: {
  model: ModelProject; connection: ClientConnection; accountKey: string;
  startingRun?: boolean;
  onNavigate(route: ModelsRoute): void; onNewRun(): void; children: ReactNode;
}) {
  const [cursor, setCursor] = useState<string | null>(null);
  const hosted = model.hosted;
  const key = useMemo(() => ["model-native-runs", connectionQueryScope(connection), accountKey, hosted?.teamId, hosted?.projectId, cursor],
    [connection, accountKey, hosted?.teamId, hosted?.projectId, cursor]);
  const native = useQuery({ queryKey: key, enabled: Boolean(hosted), retry: false, refetchInterval: 15_000,
    queryFn: async ({ signal }) => parseModelNativeRunPage(await apiFetch(connection, "/v1/training/evaluation-workspace", {
      method: "POST", signal, body: JSON.stringify({ teamId: hosted!.teamId, projectId: null, operation: "modelNativeRuns",
        value: { modelProjectId: hosted!.projectId, ...(cursor ? { cursor } : {}) } }),
    }), { modelProjectId: hosted!.projectId, teamId: hosted!.teamId, ...(cursor ? { cursor } : {}) }),
  });
  return <div className="labs-flat-body labs-resource-page">
    <ModelProjectPageHeader title={model.name} description={model.objective ?? "Training and saved versions for this Model."}
      actions={<div className="model-build-actions"><button className="training-button secondary" type="button" onClick={() => onNavigate(modelsLocation("serving", model.id, { area: "console" }))}>Inference</button><button className="training-button" type="button" disabled={startingRun} onClick={onNewRun}>New training run</button></div>} />
    <nav className="taskset-draft-tabs" aria-label="Model workspace">
      <button type="button" className="active" aria-current="page">Training</button>
      <button type="button" onClick={() => onNavigate(modelsLocation("versions", model.id))}>Versions</button>
      <button type="button" onClick={() => onNavigate(modelsLocation("models", model.id))}>Configuration</button>
    </nav>
    {children}
    {hosted ? <section className="training-detail-section" aria-label="Model modification training">
      <div className="model-build-actions"><h2>Training attempts</h2><button className="training-button secondary" type="button" onClick={() => void native.refetch()}>Refresh</button></div>
      <div className="training-table-wrap"><table className="training-data-table">
        <thead><tr><th>Run</th><th>Method</th><th>Status</th><th>Saved versions</th><th>Updated</th></tr></thead>
        <tbody>{native.data?.items.map(run => <tr key={run.id}>
          <td><button className="labs-version-row-button" type="button" onClick={() => onNavigate(modelsLocation("runs", model.id, { area: "console", projectId: run.projectId,
            resourceId: `${run.method === "engram_adapter" ? "managed-engram" : run.method === "decision_model" ? "managed-decision" : run.method === "alphaedit" ? "managed-alphaedit" : run.method === "selective_neuron_training" ? "managed-neuron-training" : run.method === "weight_space_programming" ? "managed-weight-space" : "managed-modification"}:${run.id}`,
          }))}>{run.name}</button></td><td>{statusLabel(run.method)}</td><td><LabStatusBadge value={run.phase} label={statusLabel(run.phase)} /></td><td>{run.versionHashes.length}</td><td>{formatDateTime(run.updatedAt)}</td>
        </tr>)}
          <EvaluationTableState columns={5} loading={native.isPending} error={native.error?.message}
            empty={!native.data?.items.length} retry={() => void native.refetch()}>
            No modification training attempts are attached to this Model.
          </EvaluationTableState>
        </tbody>
      </table></div>
      <div className="model-build-actions">{cursor ? <button className="training-button secondary" type="button" onClick={() => setCursor(null)}>First page</button> : null}
        {native.data?.nextCursor ? <button className="training-button secondary" type="button" onClick={() => setCursor(native.data!.nextCursor)}>Next page</button> : null}
      </div>
    </section> : null}
  </div>;
}
