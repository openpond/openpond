import type { ConnectedRecordedExecution } from "openpond-sdk/connected-evidence";
import { useState } from "react";
import type { ExperimentGraderPin } from "openpond-sdk/experiments";
import type { ModelsRoute } from "../models-route";
import type { Inventory, WorkspaceApi } from "./workspace-api";
import type { useHostedExperimentDetail } from "./useHostedExperimentDetail";
import { ExperimentCompare } from "./ExperimentCompare";
import { ScoringPassStatus } from "./ScoringPassStatus";
import { EvaluationTime } from "./EvaluationPresentation";
import { RecordedCases } from "./connected-evidence/RecordedCases";
import { RecordedGrading } from "./connected-evidence/ConnectedRecordedSetup";
import { WorkspacePanel } from "./WorkspacePanel";
import { ExperimentTrainingPanel } from "./ExperimentTrainingPanel";

export function RecordedExperimentDetail({ api, inventory, route, navigate, execution, detail, busy, onCancel }: {
  api: WorkspaceApi; inventory: Inventory | null; route: ModelsRoute;
  navigate(route: ModelsRoute): void; execution: ConnectedRecordedExecution;
  detail: ReturnType<typeof useHostedExperimentDetail>; busy: boolean; onCancel(): void;
}) {
  const tab = route.detailTab ?? "overview", pass = detail.selectedPass.data;
  const [grading, setGrading] = useState(false);
  const openGrader = (release: NonNullable<ExperimentGraderPin["release"]>) => navigate({
    ...route, page: "graders", resourceId: release.id, revision: release.revision,
    contentHash: release.contentHash, datasetKind: undefined, detailTab: "overview", passId: null, after: null,
  });
  return <>
    <nav className="evaluation-workspace-tabs" aria-label="Recorded Experiment tabs">
      {["overview", "cases", "compare", "configuration"].map(value => <button key={value}
        aria-selected={tab === value} onClick={() => navigate({ ...route, detailTab: value })}>
        {value[0]!.toUpperCase() + value.slice(1)}
      </button>)}
    </nav>
    <div className="evaluation-workspace-scope"><strong>{execution.request.name}</strong>
      <span>{execution.manifest.population.length} frozen recorded cases</span>
      <EvaluationTime value={execution.manifest.createdAt} />
    </div>
    <label>Grading<select value={route.passId ?? ""} onChange={event => navigate({ ...route, passId: event.target.value || null })}>
      <option value="">Frozen source</option>
      {detail.passItems.map(item => <option key={item.id} value={item.id}>{item.status} / {item.id}</option>)}
    </select></label>
    <button className="training-button secondary" onClick={() => setGrading(true)}>Apply grader</button>
    {grading ? <WorkspacePanel action="recorded-grader" label="Apply grader" onRequestClose={() => setGrading(false)}><RecordedGrading api={api} execution={execution} onStarted={next => {setGrading(false);navigate({...route,executionKind:"recorded_evidence",passId:next.id,detailTab:"cases"});}}/></WorkspacePanel> : null}
    {detail.passes.hasNextPage ? <button disabled={detail.passes.isFetchingNextPage} onClick={() => void detail.passes.fetchNextPage()}>More scoring passes</button> : null}
    {pass ? <ScoringPassStatus pass={pass} busy={busy} onCancel={onCancel} /> : null}
    {detail.evidence.data && pass ? <ExperimentTrainingPanel api={api} executionId={execution.id} passId={pass.id} navigate={navigate}/> : null}
    {tab === "overview" ? <section>
      <p>This Experiment grades retained input, output and trace at the frozen source boundaries.</p>
      <dl><dt>Dataset</dt><dd>{execution.manifest.dataset.id} / revision {execution.request.dataset.revision}</dd>
        <dt>Source manifest</dt><dd>{execution.manifest.contentHash}</dd>
        <dt>Grading</dt><dd>{pass?.status ?? "Select a retained scoring pass"}</dd>
        <dt>Retained results</dt><dd>{detail.evidence.data?.result.cases.length ?? 0} cases</dd>
      </dl>
      <button onClick={() => navigate({ ...route, detailTab: "cases" })}>Inspect cases</button>
    </section> : null}
    {tab === "configuration" ? <section><h2>Frozen recorded configuration</h2>
      <details open><summary>Source and population</summary><pre>{JSON.stringify({ request: execution.request, manifest: execution.manifest, sources: execution.sources.map(({ task: _task, ...source }) => source) }, null, 2)}</pre></details>
      {pass ? <details><summary>Grader configuration</summary><pre>{JSON.stringify({ request: pass.request, graders: pass.graders }, null, 2)}</pre></details> : null}
    </section> : null}
    {tab === "compare" ? <ExperimentCompare api={api} inventory={inventory} baselineId={route.passId ?? null} graders={pass?.graders ?? []} onOpenGrader={openGrader} /> : null}
    {detail.evidence.data ? <div hidden={tab !== "cases"}><RecordedCases api={api} execution={execution}
      result={detail.evidence.data.result} onSelectPass={passId => navigate({ ...route, passId, detailTab: "cases" })} /></div>
      : tab === "cases" ? <p role="status">{detail.evidence.isFetching ? "Reading retained grading…" : "Case results appear when the selected grading finishes."}</p> : null}
  </>;
}
