import { ExperimentDiagnostics } from "./ExperimentDiagnostics";
import { ExperimentRunPins } from "./ExperimentRunPins";
import { AdvancedRefinerEvaluationControl } from "./AdvancedRefinerEvaluationControl";
import { ReviewedExperimentScheduleControl } from "./ReviewedExperimentScheduleControl";
import { useRef, useState } from "react";
import type { ModelsRoute } from "../models-route";
import { useEvaluationSetup } from "./EvaluationSetupState";
import { useWorkspaceActions, useWorkspaceResourceName } from "./WorkspacePanel";
import {
  EvaluationCard,
  EvaluationModel,
  EvaluationStatus,
  EvaluationTime,
} from "./EvaluationPresentation";
import { ExperimentOverview } from "./ExperimentOverview";
import { useLocalExperimentDetail } from "./useLocalExperimentDetail";
import { LocalExperimentCollection } from "./LocalExperimentCollection";
import { CaseTableState } from "./CaseTableState";
import { ExperimentGraderLabel } from "./ExperimentGraderLabel";
import type { ExperimentGraderPin } from "openpond-sdk/experiments";
import { LocalExperimentCases } from "./LocalExperimentCases";
import { LocalExperimentCompare } from "./LocalExperimentCompare";
import { LocalExperimentGrading } from "./LocalExperimentGrading";
import { LocalExperimentUsage } from "./LocalExperimentUsage";
import type { WorkspaceApi } from "./workspace-api";
import { DropdownSelect } from "../../DropdownSelect";
import {ExperimentImproveSidebar} from "./ExperimentImproveSidebar";
export function LocalExperimentsPage({
  api,
  route,
  navigate,
  onOpenWork,
}: {
  api: WorkspaceApi;
  route: ModelsRoute;
  navigate: (route: ModelsRoute) => void;
  onOpenWork?: (id:string)=>void;
}) {
  const setup = useEvaluationSetup(),
    detail = useLocalExperimentDetail(api, route),
    execution = detail.execution.data,
    tab = route.detailTab === "cases" ? "tasks" : route.detailTab ?? "tasks";
  const [error, setError] = useState<string | null>(null),
    [busy, setBusy] = useState(false),
    active = useRef(false);
  useWorkspaceResourceName(execution?.configuration.request.name ?? null);
  const select = useWorkspaceActions([
    {
      id: "experiment",
      label: "Experiment",
      onSelect: () =>
        setup.open(
          execution
            ? {
                id: execution.id,
                request: execution.configuration.request,
                graders: execution.graders,
                maximumCostUsd: execution.configuration.maximumCostUsd,
                packageHash: execution.packageHash,
              }
            : null,
        ),
    },
  ]);
  async function mutate(action: () => Promise<void>) {
    if (active.current) return;
    active.current = true;
    setBusy(true);
    setError(null);
    try {
      await action();
      await detail.refresh();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      active.current = false;
      setBusy(false);
    }
  }
  const failure =
    error ??
    detail.execution.error?.message ??
    detail.result.error?.message ??
    detail.evidence.error?.message ??
    detail.passes.error?.message ??
    detail.selectedPass.error?.message;
  const pass = route.passId ? detail.result.data?.execution : null;
  const graders = route.passId
    ? (detail.selectedPass.data?.graders ?? [])
    : (execution?.graders ?? []);
  const openGrader = (release: NonNullable<ExperimentGraderPin["release"]>) =>
    navigate({
      ...route,
      page: "graders",
      resourceId: release.id,
      revision: release.revision,
      contentHash: release.contentHash,
      datasetKind: undefined,
      detailTab: "overview",
      passId: null,
    });
  const total = execution ? Object.values(execution.counts).reduce((a, b) => a + b, 0) : 0;
  return (
    <>
      <header className="evaluation-workspace-header">
        <h1 className="sr-only">{execution?.configuration.request.name ?? "Local Experiments"}</h1>
        <button className="training-button" disabled={busy} onClick={() => select("experiment")}>
          {execution ? "Duplicate and edit" : "Run experiment"}
        </button>
      </header>
      <p className="evaluation-meta-line">Executed and retained on this Desktop server using its signed-in account.</p>
      {failure ? <p role="alert">{failure}</p> : null}
      {!route.resourceId ? (
        <LocalExperimentCollection key={api.key} api={api} route={route} navigate={navigate} />
      ) : execution ? (
        <>
          <nav className="evaluation-workspace-tabs" aria-label="Experiment tabs">
            {["tasks", "graders", "versions", "diagnostics", "configuration", "compare"].map((value) => (
              <button
                key={value}
                aria-selected={tab === value}
                onClick={() => navigate({ ...route, detailTab: value })}
              >
                {value[0]!.toUpperCase() + value.slice(1)}
              </button>
            ))}
          </nav>
          <div className="evaluation-run-summary">
            <EvaluationModel
              name={execution.model.modelId}
              onOpen={() => navigate({ ...route, detailTab: "configuration" })}
            />
            <EvaluationStatus status={execution.status} />
            <span className="evaluation-run-counts">
              <b>{execution.counts.completed}</b> completed · <b>{execution.counts.failed}</b> failed ·{" "}
              <b>{execution.counts.running}</b> running · <b>{execution.counts.pending}</b> pending ·{" "}
              <b>{total}</b> attempts
            </span>
            <span aria-hidden="true">·</span>
            <EvaluationTime value={execution.createdAt} />
            {!execution.completedAt ? (
              <button
                className="training-button secondary"
                disabled={busy || execution.status === "cancelling"}
                onClick={() =>
                  void mutate(async () => {
                    await api.local("cancel", { id: execution.id });
                  })
                }
              >
                Cancel Experiment
              </button>
            ) : null}
          </div>
          {detail.passes.data?.pages.some((page) => page.items.length) ? (
            <div className="evaluation-pass-select">
              <span>Grading</span>
              <DropdownSelect
                label="Grading"
                value={route.passId ?? ""}
                options={[
                  { value: "", label: "Original Experiment grading" },
                  ...detail.passes.data.pages
                    .flatMap((page) => page.items)
                    .map((item) => ({
                      value: item.id,
                      label: `Scoring pass ${item.id.slice(-8)}`,
                      description: item.status.replaceAll("_", " "),
                    })),
                ]}
                onChange={(value) => navigate({ ...route, passId: value || null })}
              />
            </div>
          ) : null}
          {detail.passes.hasNextPage ? (
            <button
              className="training-button secondary evaluation-more"
              onClick={() => void detail.passes.fetchNextPage()}
            >
              More scoring passes
            </button>
          ) : null}
          {pass ? (
            <EvaluationCard title="Selected scoring pass">
              <EvaluationStatus status={pass.status} />
              {!pass.completedAt ? (
                <button
                  disabled={busy || pass.status === "cancelling"}
                  onClick={() =>
                    void mutate(async () => {
                      await api.local("cancel", { id: pass.id });
                    })
                  }
                >
                  Cancel scoring pass
                </button>
              ) : null}
            </EvaluationCard>
          ) : null}
          {tab === "overview" ? (
            <ExperimentOverview
              runs={[
                {
                  id: execution.id,
                  name: execution.configuration.request.name ?? "Experiment",
                  model: execution.model.modelId,
                  status: execution.status,
                  createdAt: execution.createdAt,
                  total,
                  completed: execution.counts.completed,
                  failed: execution.counts.failed,
                },
              ]}
              tokens={[]}
              loading={detail.result.isFetching}
              error={detail.result.error?.message}
              retry={() => void detail.result.refetch()}
              onSelect={() => navigate({ ...route, detailTab: "cases" })}
              onConfiguration={() => navigate({ ...route, detailTab: "configuration" })}
              tokenNote="This local result contract does not retain token counts. Usage stays unknown; measured spend is shown separately."
            />
          ) : null}
          {tab === "diagnostics" ? <ExperimentDiagnostics key={api.key+execution.id} api={api} id={execution.id} manifestHash={execution.executionHash}/> : null}
          {tab === "graders" || tab === "versions" ? <ExperimentRunPins configuration={{...execution.configuration,configurationHash:execution.configurationHash,graders:execution.graders}} section={tab}/> : null}
          {tab === "configuration" ? (
            <>
              <EvaluationCard title="Immutable run configuration">
                <dl>
                  <dt>Model</dt>
                  <dd>{execution.model.modelId}</dd>
                  <dt>Dataset</dt>
                  <dd>
                    Version {execution.configuration.request.taskset.revision} ·{" "}
                    {execution.configuration.request.taskset.id}
                  </dd>
                  <dt>Whole-run spending cap</dt>
                  <dd>${execution.configuration.maximumCostUsd}</dd>
                  <dt>Graders</dt>
                  <dd>
                    {execution.graders.map((grader) => (
                      <ExperimentGraderLabel key={grader.id} grader={grader} onOpen={openGrader} />
                    ))}
                  </dd>
                </dl>
                <details>
                  <summary>Advanced configuration</summary>
                  <pre>
                    {JSON.stringify(
                      {
                        configuration: execution.configuration,
                        configurationHash: execution.configurationHash,
                        packageHash: execution.packageHash,
                        model: execution.model,
                      },
                      null,
                      2,
                    )}
                  </pre>
                </details>
              </EvaluationCard>
              {pass ? (
                <EvaluationCard title="Selected grading configuration">
                  <pre>
                    {JSON.stringify(
                      {
                        id: pass.id,
                        executionHash: pass.executionHash,
                        source: pass.sourceExecution,
                        graders: detail.selectedPass.data?.graders,
                        maximumCostUsd: pass.maximumCostUsd,
                      },
                      null,
                      2,
                    )}
                  </pre>
                </EvaluationCard>
              ) : null}
            </>
          ) : null}
          {tab !== "configuration" ? <LocalExperimentUsage execution={pass ?? execution} /> : null}
          <LocalExperimentGrading
            key={execution.id}
            api={api}
            definition={execution}
            execution={execution}
            busy={busy}
            onApply={(action) =>
              void mutate(async () => {
                const next = await action();
                navigate({ ...route, passId: next.id, detailTab: "cases" });
              })
            }
          />
          {tab === "compare" ? (
            <LocalExperimentCompare
              key={`${detail.resultId}:compare`}
              api={api}
              baselineId={detail.resultId}
              graders={graders}
              onOpenGrader={openGrader}
            />
          ) : null}
          {detail.result.data ? (
            <div hidden={tab !== "tasks"}>
              <LocalExperimentCases
                key={detail.resultId}
                api={api}
                result={detail.result.data}
                humanDataset={execution.configuration.request.taskset}
                humanContext={api.humanContext ?? undefined}
                projectId={execution.configuration.request.project?.id}
                humanGraders={execution.graders.map(pin => ({ id: pin.id, name: pin.name ?? pin.id }))}
                graders={graders}
                onOpenGrader={openGrader}
              />
            </div>
          ) : tab === "tasks" ? (
            <CaseTableState
              headers={["Task", "Seed", "Status", "Overall score"]}
              loading={detail.result.isFetching}
              error={detail.result.error?.message}
              retry={() => void detail.result.refetch()}
            />
          ) : null}
        </>
      ) : (
        <p role="status">
          {detail.execution.isPending ? "Loading Experiment…" : "This Experiment is unavailable."}
        </p>
      )}
      <AdvancedRefinerEvaluationControl api={api} evidence={detail.evidence.data?.result.status==="completed"?{id:detail.evidence.data.manifest.id,contentHash:detail.evidence.data.result.contentHash}:null}/>
      <ReviewedExperimentScheduleControl api={api} configuration={execution?.configuration??null} onOpenExperiment={id=>navigate({...route,page:"experiments",resourceId:id,passId:null,detailTab:"overview"})}/>
      <ExperimentImproveSidebar api={api} evidence={detail.evidence.data??null} onOpenWork={onOpenWork}/>
    </>
  );
}
