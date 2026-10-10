import { AdmittedExperimentTasks } from "./AdmittedExperimentTasks";
import { ExperimentDiagnostics } from "./ExperimentDiagnostics";
import { ExperimentRunPins } from "./ExperimentRunPins";
import { RunExperimentSchema } from "openpond-sdk/experiments";
import { AdvancedRefinerEvaluationControl } from "./AdvancedRefinerEvaluationControl";
import { ReviewedExperimentScheduleControl } from "./ReviewedExperimentScheduleControl";
import { ExperimentOverview } from "./ExperimentOverview";
import { RecordedExperimentDetail } from "./RecordedExperimentDetail";
import { RecordedExperimentCollection } from "./RecordedExperimentCollection";
import { ExperimentTrainingPanel } from "./ExperimentTrainingPanel";
import { EvaluationModel, EvaluationStatus, EvaluationTime } from "./EvaluationPresentation";
import { ExperimentCompare } from "./ExperimentCompare";
import { HostedExperimentCollection } from "./HostedExperimentCollection";
import { useWorkspaceActions, useWorkspaceResourceName } from "./WorkspacePanel";
import { useRef, useState } from "react";
import type { ModelsRoute } from "../models-route";
import { useEvaluationSetup } from "./EvaluationSetupState";
import type { ExperimentGraderPin } from "openpond-sdk/experiments";
import { ExperimentCases } from "./ExperimentCases";
import { ExperimentConfiguration } from "./ExperimentConfiguration";
import { ScoringPassStatus } from "./ScoringPassStatus";
import { useHostedExperimentDetail } from "./useHostedExperimentDetail";
import type { Inventory, WorkspaceApi } from "./workspace-api";
import {ExperimentImproveSidebar} from "./ExperimentImproveSidebar";
import { DropdownSelect } from "../../DropdownSelect";
export function HostedExperimentsPage({
  api,
  inventory,
  route,
  navigate,
  refresh,
  inventoryError,
  inventoryLoading,
  onOpenWork,
}: {
  api: WorkspaceApi;
  inventory: Inventory | null;
  route: ModelsRoute;
  navigate: (route: ModelsRoute) => void;
  refresh: () => void;
  inventoryError?: string;
  inventoryLoading?: boolean;
  onOpenWork?: (id:string)=>void;
}) {
  const setup = useEvaluationSetup(),
    detail = useHostedExperimentDetail(api, route),
    run = detail.execution.data,
    tab = route.detailTab === "cases" ? "tasks" : route.detailTab ?? "tasks";
  const [busy, setBusy] = useState(false),
    [error, setError] = useState<string | null>(null),
    active = useRef(false);
  async function mutate(action: () => Promise<void>) {
    if (active.current) return;
    active.current = true;
    setBusy(true);
    setError(null);
    try {
      await action();
      await detail.refresh();
      refresh();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      active.current = false;
      setBusy(false);
    }
  }
  const select = useWorkspaceActions(
    !route.resourceId || run
      ? [
          {
            id: "experiment",
            label: "Experiment",
            onSelect: () =>
              setup.open(
                run
                  ? {
                      id: run.summary.id,
                      request: run.request,
                      graders: run.configuration.graders,
                      maximumCostUsd: run.configuration.maximumCostUsd,
                    }
                  : null,
                null,
                null,
                inventory?.projects.projects.find((project) => project.id === api.projectId)
                  ?.content.defaultTargetId ?? "model",
              ),
          },
        ]
      : [],
  );
  useWorkspaceResourceName(run?.request.name ?? detail.recorded.data?.request.name ?? null);
  const failure =
    error ??
    detail.execution.error?.message ??
    detail.recorded.error?.message ??
    detail.passes.error?.message ??
    detail.selectedPass.error?.message ??
    detail.evidence.error?.message;
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
      after: null,
    });
  const selectedGraders =
    detail.selectedPass.data?.graders ?? (route.passId ? [] : (run?.configuration.graders ?? []));
  return (
    <>
      <header className="evaluation-workspace-header">
        <h1 className="sr-only">{run?.request.name ?? detail.recorded.data?.request.name ?? "Experiments"}</h1>
        {!route.resourceId ? (
          <input
            aria-label="Search experiments"
            placeholder="Search experiments"
            value={route.query}
            onChange={(event) => navigate({ ...route, query: event.target.value, after: null })}
          />
        ) : null}
        {!route.resourceId || run ? (
          <button className="training-button" disabled={busy} onClick={() => select("experiment")}>
            {run ? "Duplicate and edit" : "Run experiment"}
          </button>
        ) : null}
      </header>
      {failure ? <p role="alert">{failure}</p> : null}
      {!route.resourceId ? (
        <>
          <HostedExperimentCollection
            api={api}
            key={api.key}
            items={inventory?.experiments.items ?? []}
            loading={inventoryLoading ?? !inventory}
            error={inventoryError}
            retry={refresh}
            route={route}
            navigate={navigate}
          />
          {inventory?.experiments.nextCursor ? (
            <button
              className="training-button secondary evaluation-more"
              onClick={() => navigate({ ...route, after: inventory.experiments.nextCursor })}
            >
              More Experiments
            </button>
          ) : null}
          <RecordedExperimentCollection api={api} route={route} navigate={navigate}/>
        </>
      ) : detail.recorded.data ? (
        <RecordedExperimentDetail api={api} inventory={inventory} route={route} navigate={navigate}
          execution={detail.recorded.data} detail={detail} busy={busy}
          onCancel={() => void mutate(async () => {
            if (detail.selectedPass.data) await api.request("cancelPass", { id: detail.selectedPass.data.id });
          })} />
      ) : run ? (
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
              name={
                "modelId" in run.request.policy ? run.request.policy.modelId : "Authored fixtures"
              }
              onOpen={() => navigate({ ...route, detailTab: "configuration" })}
            />
            <EvaluationStatus status={run.summary.status} />
            <span className="evaluation-run-counts">
              <b>{run.summary.counts.completed}</b> completed · <b>{run.summary.counts.failed}</b>{" "}
              failed · <b>{run.summary.counts.running}</b> running ·{" "}
              <b>{run.summary.counts.pending}</b> pending · <b>{run.summary.totalCount}</b> attempts
            </span>
            <span aria-hidden="true">·</span>
            <EvaluationTime value={run.summary.startedAt ?? run.summary.createdAt} />
            {["queued", "running", "cancelling"].includes(run.summary.status) ? (
              <button
                className="training-button secondary"
                disabled={busy || run.summary.status === "cancelling"}
                onClick={() =>
                  void mutate(async () => {
                    await api.request("cancel", { id: run.summary.id });
                  })
                }
              >
                Cancel Experiment
              </button>
            ) : null}
          </div>
          {detail.evidence.data ? <ExperimentTrainingPanel api={api} executionId={run.summary.id} passId={route.passId} navigate={navigate}/> : null}
          {detail.passItems.length ? (
            <div className="evaluation-pass-select">
              <span>Grading</span>
              <DropdownSelect
                label="Grading"
                value={route.passId ?? ""}
                options={[
                  { value: "", label: "Original Experiment grading" },
                  ...detail.passItems.map((pass) => ({
                    value: pass.id,
                    label: `Scoring pass ${pass.id.slice(-8)}`,
                    description: pass.status.replaceAll("_", " "),
                  })),
                ]}
                onChange={(value) => navigate({ ...route, passId: value || null })}
              />
            </div>
          ) : null}
          {detail.selectedPass.data ? (
            <ScoringPassStatus
              pass={detail.selectedPass.data}
              busy={busy}
              onCancel={() =>
                void mutate(async () => {
                  await api.request("cancelPass", { id: detail.selectedPass.data!.id });
                })
              }
            />
          ) : null}
          {detail.passes.hasNextPage ? (
            <button
              className="training-button secondary evaluation-more"
              disabled={detail.passes.isFetchingNextPage}
              onClick={() => void detail.passes.fetchNextPage()}
            >
              More scoring passes
            </button>
          ) : null}
          {tab === "overview" ? (
            <ExperimentOverview
              runs={[
                {
                  id: run.summary.id,
                  name: run.request.name ?? "Experiment",
                  model:
                    "modelId" in run.request.policy
                      ? run.request.policy.modelId
                      : "Authored fixtures",
                  status: run.summary.status,
                  createdAt: run.summary.startedAt ?? run.summary.createdAt,
                  total: run.summary.totalCount,
                  completed: run.summary.counts.completed,
                  failed: run.summary.counts.failed,
                },
              ]}
              tokens={
                detail.evidence.data?.result.cases.slice(0, 20).map((item) => ({
                  id: JSON.stringify(item.identity),
                  label: `${item.identity.caseId} / ${item.identity.seed}`,
                  value: item.usage.totalTokens,
                })) ?? []
              }
              loading={detail.evidence.isFetching}
              error={detail.evidence.error?.message}
              retry={() => void detail.evidence.refetch()}
              onSelect={() => navigate({ ...route, detailTab: "cases" })}
              onConfiguration={() => navigate({ ...route, detailTab: "configuration" })}
              tokenNote="First 20 persisted cases from this Experiment or the explicitly selected scoring pass. Unknown usage stays unknown."
            />
          ) : null}
          {tab === "diagnostics" ? <ExperimentDiagnostics key={api.key+run.summary.id} api={api} id={run.summary.id} manifestHash={run.summary.manifestHash}/> : null}
          {tab === "graders" || tab === "versions" ? <ExperimentRunPins configuration={run.configuration} section={tab}/> : null}
          {tab === "configuration" ? (
            <ExperimentConfiguration
              execution={run}
              pass={detail.selectedPass.data ?? null}
              onOpenGrader={openGrader}
            />
          ) : null}
          {tab === "compare" ? (
            <ExperimentCompare
              key={`${run.summary.id}:${route.passId ?? "original"}`}
              api={api}
              inventory={inventory}
              baselineId={route.passId ?? run.summary.id}
              graders={selectedGraders}
              onOpenGrader={openGrader}
            />
          ) : null}
          {detail.evidence.data ? (
            <div hidden={tab !== "tasks"}>
              <ExperimentCases
                key={`${run.summary.id}:${route.passId ?? "original"}`}
                evidence={detail.evidence.data}
                api={api}
                execution={run}
                saved={run.configuration}
                humanContext={api.humanContext ?? undefined}
                projectId={run.request.project?.id}
                humanGraders={run.configuration.graders.map(pin => ({ id: pin.id, name: pin.name ?? pin.id }))}
                graders={selectedGraders}
                onOpenGrader={openGrader}
                busy={busy}
                onScore={(action) => void mutate(action)}
                onSelectPass={(passId) => navigate({ ...route, passId, detailTab: "cases" })}
              />
            </div>
          ) : tab === "tasks" ? (
            <AdmittedExperimentTasks api={api} run={run}/>
          ) : null}
        </>
      ) : (
        <p role="status">
          {!failure && (detail.execution.isFetching || detail.recorded.isFetching || detail.selectedPass.isFetching)
            ? "Loading Experiment…"
            : "This Experiment is unavailable in the selected workspace."}
        </p>
      )}
      <AdvancedRefinerEvaluationControl api={api} evidence={detail.evidence.data?.result.status==="completed"?{id:detail.evidence.data.manifest.id,contentHash:detail.evidence.data.result.contentHash}:null}/>
      <ReviewedExperimentScheduleControl api={api} configuration={run?RunExperimentSchema.parse({request:run.request,maximumCostUsd:run.configuration.maximumCostUsd,operationId:run.request.operationId,graders:run.configuration.graders.map(({id,version,contentHash,mappings})=>({id,version,contentHash,mappings:mappings??[]}))}):null} onOpenExperiment={id=>navigate({...route,page:"experiments",resourceId:id,passId:null,detailTab:"overview"})}/>
      <ExperimentImproveSidebar api={api} evidence={detail.evidence.data??null} onOpenWork={onOpenWork}/>
    </>
  );
}
