import { ActivationCaptureResult } from "./ActivationCaptureResult";
import { useQuery } from "@tanstack/react-query";
import { experimentOperationLabel } from "openpond-sdk/training";
import { ErrorToast } from "../../common/ErrorToast";
import { modificationRecordingApi } from "./modification-recording-api";
import { EvaluationCard } from "./EvaluationPresentation";
import { useWorkspaceResourceName } from "./WorkspacePanel";
import type { WorkspaceApi } from "./workspace-api";

export function ModificationRecordingDetail({ api, id }: { api: WorkspaceApi; id: string }) {
  const read = useQuery({ queryKey: ["modification-recording", api.key, api.actorId, id],
    queryFn: ({ signal }) => modificationRecordingApi(api, signal).read(id), retry: false });
  const value = read.data, request = value?.document.request, result = value?.document.result;
  useWorkspaceResourceName(value?.recording.name ?? "Observation");
  return <>
    <header className="evaluation-workspace-header"><h1>{value?.recording.name ?? "Observation"}</h1>
      <button className="training-button secondary" onClick={() => void read.refetch()}>Refresh observation</button></header>
    <ErrorToast error={read.error} />
    {read.isPending ? <p role="status">Loading observation…</p> : null}
    {value && request && result ? <>
      <EvaluationCard title="External observation">
        <p>Retained on this device. Integrity and capture coverage are verified; measurements were supplied by an external runtime. This is ungraded evidence.</p>
        <dl className="evaluation-workspace-meta"><dt>Method</dt><dd>{experimentOperationLabel(value.recording.method)}</dd>
          <dt>Model</dt><dd>{request.model.modelId}</dd><dt>Revision</dt><dd>{request.model.revision}</dd>
          <dt>Reported runtime</dt><dd>{result.runtime.implementation} · {result.runtime.device}</dd>
          <dt>Captured values</dt><dd>{result.captures.length * 2}</dd><dt>Recorded</dt><dd>{value.recording.createdAt}</dd></dl>
      </EvaluationCard>
      <ActivationCaptureResult request={request} result={result} />
    </> : null}
  </>;
}
