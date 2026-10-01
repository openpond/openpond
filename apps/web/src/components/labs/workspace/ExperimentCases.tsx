import {useHumanGraderChoices} from "../../human-review/useHumanGraderChoices";
import {HumanReviewLaunch} from "../../human-review/HumanReviewLaunch";
import {HumanResultControls} from "../../human-review/HumanResultControls";
import {HumanReviewInspector} from "../../human-review/HumanReviewInspector";
import {humanApi,type HumanInboxContext} from "../../human-review/api";
import type {HumanReviewView} from "@openpond/evals/human-review";
import { EvaluationTableState } from "./EvaluationTableState";
import { ExperimentGraderLabel, experimentGraderName } from "./ExperimentGraderLabel";
import type { ExperimentGraderPin } from "openpond-sdk/experiments";
import { useDraftNavigation } from "../useDraftNavigation";
import { CaseUsage } from "./CaseUsage";
import { EvaluationCard, EvaluationStatus } from "./EvaluationPresentation";
import { GraderReleasePicker } from "./GraderReleasePicker";
import { GraderFieldMappings } from "./GraderFieldMappings";
import { learningRef, type RewardRelease } from "openpond-sdk/learning";
import {
  ExperimentFieldMappingsSchema,
  type ExperimentFieldMapping,
} from "openpond-sdk/experiments";
import { useQuery } from "@tanstack/react-query";
import type { ExperimentCaseInspection } from "openpond-sdk/experiments";
import { WorkspacePanel, useWorkspaceActions, useWorkspacePanelControls } from "./WorkspacePanel";
import { useState } from "react";
import { type ExperimentRunDetails, type ExperimentScoringPass } from "openpond-sdk/experiments";
import type { ModelTasksetRunDetails } from "openpond-sdk/model-taskset-runs";
import type { ExperimentEvidence, WorkspaceApi } from "./workspace-api";
export function ExperimentCases({
  evidence,
  api,
  execution,
  saved,
  busy,
  onScore,
  onSelectPass,
  graders = saved.graders,
  onOpenGrader, humanContext:contextInput, projectId:projectInput,
}: {
  evidence: ExperimentEvidence;
  humanContext?:HumanInboxContext; projectId?:string; humanGraders?:{id:string;name:string}[]; humanDataset?:{id:string;revision:number;contentHash:string};
  api: WorkspaceApi;
  execution: ModelTasksetRunDetails | null;
  saved: {
    request: ExperimentRunDetails["request"];
    graders: ExperimentRunDetails["configuration"]["graders"];
    maximumCostUsd: number;
  };
  graders?: ExperimentGraderPin[];
  onOpenGrader?: (release: NonNullable<ExperimentGraderPin["release"]>) => void;
  busy: boolean;
  onScore: (action: () => Promise<void>) => void;
  onSelectPass: (id: string) => void;
}) {
  const humanContext=contextInput??api.humanContext??undefined,projectId=projectInput??api.projectId??undefined;
  const humanChoices=useHumanGraderChoices(humanContext,projectId,saved.request.taskset),humanGraders=humanChoices.choices;
  const [humanReview,setHumanReview]=useState<HumanReviewView|null>(null),[humanError,setHumanError]=useState<string|null>(null);
  async function openHuman(id:string){if(!humanContext)return;try{setHumanReview(await humanApi.get(humanContext,id));}catch(e){setHumanError(e instanceof Error?e.message:"Review unavailable.");}}
  const controls = useWorkspacePanelControls();
  const [selected, setSelected] = useState<string | null>(null);
  const [selectingGrader, setSelectingGrader] = useState(false);
  const [newGrader, setNewGrader] = useState<RewardRelease | null>(null);
  const [newMappings, setNewMappings] = useState<ExperimentFieldMapping[]>([]);
  const [scoreBudget, setScoreBudget] = useState(saved.maximumCostUsd);
  const gradingState = JSON.stringify({
    grader: newGrader ? learningRef(newGrader) : null,
    mappings: newMappings,
    budget: scoreBudget,
  });
  const [gradingBaseline, setGradingBaseline] = useState(gradingState);
  const gradingGuard = useDraftNavigation({
    name: "Retained output grading",
    dirty: selectingGrader && gradingState !== gradingBaseline,
    busy: selectingGrader && busy,
    onLeave: () => setSelectingGrader(false),
  });
  function openGrading() {
    if (!selectingGrader) setGradingBaseline(gradingState);
    setSelectingGrader(true);
  }
  const cases = evidence.result.cases;
  const [eventCursor, setEventCursor] = useState<string | undefined>();
  const item = cases.find((row) => JSON.stringify(row.identity) === selected);
  const population = execution?.request.population.find(
    (member) =>
      member.taskId === item?.identity.caseId &&
      member.seed === item.identity.seed &&
      member.fixtureId === item.identity.fixtureId,
  );
  const inspection = useQuery({
    queryKey: [
      "evaluation-workspace",
      api.key,
      "case",
      execution?.summary.id,
      population?.receiptId,
      eventCursor,
    ],
    enabled: Boolean(execution && population),
    queryFn: ({ signal }) =>
      api.request<ExperimentCaseInspection>(
        "case",
        {
          id: execution!.summary.id,
          receiptId: population!.receiptId,
          ...(eventCursor ? { afterId: eventCursor } : {}),
        },
        signal,
      ),
  });
  const totalTokens = cases.every((row) => row.usage.totalTokens !== null)
    ? cases.reduce((total, row) => total + row.usage.totalTokens!, 0)
    : null;
  const cost = cases.every((row) => row.usage.costUsd !== null)
    ? cases.reduce((total, row) => total + Number(row.usage.costUsd), 0)
    : null;
  function score(useNewGrader = selectingGrader) {
    if (!execution) return;
    onScore(async () => {
      const graders = useNewGrader
        ? newGrader
          ? [learningRef(newGrader)]
          : []
        : saved.graders.flatMap((grader) => (grader.release ? [grader.release] : []));
      if (!graders.length)
        throw new Error("Select a published reusable grader for a retained-output scoring pass.");
      const fields =
        useNewGrader && newGrader
          ? [{ graderId: newGrader.id, fields: ExperimentFieldMappingsSchema.parse(newMappings) }]
          : saved.graders.flatMap((grader) =>
              grader.release
                ? [{ graderId: grader.release.id, fields: grader.mappings ?? [] }]
                : [],
            );
      const request = {
        execution: { id: execution.summary.id, contentHash: execution.summary.manifestHash },
        graders,
        maximumCostUsd: scoreBudget,
        mappings: fields,
      };
      const operation = await api.operation("score", request);
      const pass = await api.request<ExperimentScoringPass>("score", {
        ...request,
        operationId: operation.id,
      });
      await operation.acknowledge();
      gradingGuard.allowNextNavigation();
      setSelectingGrader(false);
      onSelectPass(pass.id);
    });
  }
  function inspectCase(key: string) {
    setSelected(key);
    setEventCursor(undefined);
    controls?.select({ id: "case", label: "Case", onSelect: () => {} });
  }
  const selectSidebarAction = useWorkspaceActions([
    ...(execution ? [{ id: "grader", label: "Grader", onSelect: openGrading }] : []),
    ...(item ? [{ id: "case", label: "Case", onSelect: () => {} }] : []),
  ]);
  return (
    <>
      {gradingGuard.dialog}
      <p>
        {cases.length} retained cases,{" "}
        {totalTokens === null
          ? "Tokens unknown"
          : `${totalTokens.toLocaleString()} recorded tokens`}{" "}
       , {cost === null ? "Spend unknown" : `$${cost.toFixed(6)} recorded spend`}
      </p>
      <button
        className="training-button secondary"
        disabled={busy || !execution}
        onClick={() => selectSidebarAction("grader")}
      >
        Apply a different grader
      </button>
      <EvaluationCard title="Retained grading">
        <div className="evaluation-workspace-scope">
          <label>
            Grading budget ($){" "}
            <input
              type="number"
              min="0.000001"
              step="0.000001"
              value={scoreBudget}
              onChange={(event) => setScoreBudget(Number(event.target.value))}
            />
          </label>
          <button
            className="training-button secondary"
            disabled={busy || !execution || !saved.graders.some((grader) => grader.release)}
            onClick={() => {
              setSelectingGrader(false);
              score(false);
            }}
          >
            Reapply original graders
          </button>
        </div>
      </EvaluationCard>
      {selectingGrader ? (
        <WorkspacePanel
          action="grader"
          label="Retained output grading"
          onRequestClose={() => void gradingGuard.requestLeave(() => setSelectingGrader(false))}
        >
          <header>
            <h2>Apply grader</h2>
          </header>
          <EvaluationCard title="Retained Experiment">
            <p>
              {saved.request.name}, {execution?.summary.id}
            </p>
            <p>Dataset revision {execution?.summary.taskset.revision}</p>
          </EvaluationCard>
          <EvaluationCard title="Grader and version">
            <GraderReleasePicker api={api} value={newGrader} onChange={setNewGrader} />
          </EvaluationCard>
          <EvaluationCard title="Field mappings">
            <GraderFieldMappings value={newMappings} onChange={setNewMappings} />
          </EvaluationCard>
          <EvaluationCard title="Grading budget">
            <label>
              Grading cost limit ($)
              <input
                type="number"
                min="0.000001"
                step="0.000001"
                value={scoreBudget}
                onChange={(event) => setScoreBudget(Number(event.target.value))}
              />
            </label>
            <p>
              This creates a separate scoring pass against retained outputs. Original results keep
              their grader pins.
            </p>
          </EvaluationCard>
          <button
            className="training-button"
            disabled={
              busy || !newGrader || !ExperimentFieldMappingsSchema.safeParse(newMappings).success
            }
            onClick={() => score(true)}
          >
            Grade retained output
          </button>
        </WorkspacePanel>
      ) : null}
      <table className="training-data-table evaluation-workspace-table">
        <thead>
          <tr>
            <th>Case</th>
            <th>Status</th>
            {evidence.manifest.evaluators.map((grader) => (
              <th key={grader.feedbackKey}>
                {graders.find((pin) => pin.feedbackKey === grader.feedbackKey) ? (
                  <ExperimentGraderLabel
                    grader={graders.find((pin) => pin.feedbackKey === grader.feedbackKey)!}
                    onOpen={onOpenGrader}
                  />
                ) : (
                  "Grader name unavailable"
                )}
              </th>
            ))}
            <th>Tokens</th>
            <th>Spend</th>
          </tr>
        </thead>
        <tbody>
          {cases.map((row) => {
            const key = JSON.stringify(row.identity);
            return (
              <tr
                key={key}
                tabIndex={0}
                onClick={() => inspectCase(key)}
                onKeyDown={(event) => {
                  if (event.key === "Enter") inspectCase(key);
                }}
              >
                <td>
                  {row.identity.caseId}, Seed {row.identity.seed}
                </td>
                <td>
                  <EvaluationStatus status={row.status} />
                </td>
                {evidence.manifest.evaluators.map((grader) => {
                  const feedback = row.feedback.find(
                    (value) => value.feedbackKey === grader.feedbackKey,
                  );
                  return (
                    <td key={grader.feedbackKey}>
                      {feedback?.status === "scored"
                        ? String(feedback.value)
                        : (feedback?.status ?? "Not scored")}
                    </td>
                  );
                })}
                <td>{row.usage.totalTokens ?? "Unknown"}</td>
                <td>
                  {row.usage.costUsd === null
                    ? "Unknown"
                    : `$${Number(row.usage.costUsd).toFixed(6)}`}
                </td>
              </tr>
            );
          })}
          <EvaluationTableState
            columns={4 + evidence.manifest.evaluators.length}
            empty={!cases.length}
          >
            Open a completed Experiment to inspect its retained cases.
          </EvaluationTableState>
        </tbody>
      </table>
      {item ? (
        <WorkspacePanel
          action="case"
          label="Case inspector"
          onRequestClose={() => setSelected(null)}
        >
          <header>
            <h2>{item.identity.caseId}</h2>
          {humanContext && projectId && execution && population?<HumanReviewLaunch context={humanContext} projectId={projectId} selections={[{executionId:execution.summary.id,receiptId:population.receiptId}]} graders={humanGraders} onOpenReview={setHumanReview}/>:null}
          </header>
          <p>
            <EvaluationStatus status={item.status} />
          </p>
          {inspection.error ? <p role="alert">{inspection.error.message}</p> : null}
          <EvaluationCard title="Retained input">
            {inspection.data?.input ? (
              <pre>{JSON.stringify(inspection.data.input, null, 2)}</pre>
            ) : (
              <p>{inspection.isPending ? "Loading retained input…" : "Input not retained."}</p>
            )}
          </EvaluationCard>
          <EvaluationCard title="Output">
            <pre>
              {typeof item.output === "string" ? item.output : JSON.stringify(item.output, null, 2)}
            </pre>
          </EvaluationCard>
          {item.error ? (
            <p role="alert">
              {item.error.code}: {item.error.message}
            </p>
          ) : null}
          {item.feedback.map((feedback) => (
            <EvaluationCard
              key={feedback.feedbackKey}
              title={experimentGraderName(graders, feedback.feedbackKey)}
            >
              <p className="evaluation-workspace-meta">
                Feedback key: <code>{feedback.feedbackKey}</code>
              </p>
              <p>
                {feedback.status}, {feedback.value === null ? "No score" : String(feedback.value)}
                {feedback.passed === null || feedback.passed === undefined
                  ? ""
                  : feedback.passed
                    ? ", Pass"
                    : ", Fail"}
              </p>
              {feedback.reasoning ? <p>{feedback.reasoning}</p> : null}
            </EvaluationCard>
          ))}
          <EvaluationCard title="Usage">
            {execution && population ? (
              <CaseUsage
                api={api}
                executionId={execution.summary.id}
                receiptId={population.receiptId}
                pass={Boolean(evidence.passId)}
                usage={{
                  totalTokens: item.usage.totalTokens,
                  costUsd: item.usage.costUsd === null ? null : Number(item.usage.costUsd),
                }}
              />
            ) : (
              <pre>{JSON.stringify(item.usage, null, 2)}</pre>
            )}
          </EvaluationCard>
          <EvaluationCard title="Available trace">
            {inspection.data?.events.length ? (
              <ol>
                {inspection.data.events.map((event, index) => (
                  <li key={String(event.id ?? event.sequence ?? index)}>
                    <pre>{JSON.stringify(event, null, 2)}</pre>
                  </li>
                ))}
              </ol>
            ) : (
              <p>No trace events retained for this case.</p>
            )}
            {eventCursor ? (
              <button onClick={() => setEventCursor(undefined)}>First trace page</button>
            ) : null}
            {inspection.data?.nextEventCursor ? (
              <button onClick={() => setEventCursor(inspection.data!.nextEventCursor!)}>
                Next trace page
              </button>
            ) : null}
            {item.traceRef ? (
              <details>
                <summary>Trace identity</summary>
                <pre>{JSON.stringify(item.traceRef, null, 2)}</pre>
              </details>
            ) : null}
          </EvaluationCard>
          <EvaluationCard title="Artifacts">
            <pre>
              {JSON.stringify(
                item.feedback.flatMap((feedback) => feedback.evidenceRefs),
                null,
                2,
              )}
            </pre>
          </EvaluationCard>
        </WorkspacePanel>
      ) : null}
      {humanError?<p role="alert">{humanError}</p>:null}
      {humanContext && execution ? <HumanResultControls context={humanContext} executionId={execution!.summary.id} onOpenReview={id=>void openHuman(id)}/>:null}
      {humanContext&&humanReview?<WorkspacePanel action="human-review" label={humanReview.title} onRequestClose={()=>setHumanReview(null)}><HumanReviewInspector context={humanContext} record={humanReview} onChanged={setHumanReview} onClose={()=>setHumanReview(null)}/></WorkspacePanel>:null}
    </>
  );
}
