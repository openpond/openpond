import {LocalPublishedHumanResults} from "../../human-review/LocalPublishedHumanResults";
import {z} from "zod";
import {ClaudeProcessControls} from "../../human-review/ClaudeProcessControls";
import {useHumanGraderChoices} from "../../human-review/useHumanGraderChoices";
import {HumanReviewLaunch} from "../../human-review/HumanReviewLaunch";
import {HumanResultControls} from "../../human-review/HumanResultControls";
import {HumanReviewInspector} from "../../human-review/HumanReviewInspector";
import {humanApi,type HumanInboxContext} from "../../human-review/api";
import type {HumanReviewView} from "@openpond/evals/human-review";
import { ExperimentGraderLabel } from "./ExperimentGraderLabel";
import type { ExperimentGraderPin } from "openpond-sdk/experiments";
import { EvaluationTableState } from "./EvaluationTableState";
import { useEffect,useState } from "react";
import { useQuery } from "@tanstack/react-query";
import {
  LocalExperimentCaseInspectionSchema,
  type LocalExperimentResult,
} from "@openpond/contracts";
import { localRequest } from "./local-workspace-api";
import { WorkspacePanel, useWorkspaceActions, useWorkspacePanelControls } from "./WorkspacePanel";
import { EvaluationCard, EvaluationStatus } from "./EvaluationPresentation";
import type { WorkspaceApi } from "./workspace-api";

export function LocalExperimentCases({
  api,
  result,
  graders = [],
  onOpenGrader, humanContext:contextInput, projectId:projectInput, humanDataset,
}: {
  humanContext?:HumanInboxContext; projectId?:string; humanGraders?:{id:string;name:string}[]; humanDataset?:{id:string;revision:number;contentHash:string};
  api: WorkspaceApi;
  result: LocalExperimentResult;
  graders?: ExperimentGraderPin[];
  onOpenGrader?: (release: NonNullable<ExperimentGraderPin["release"]>) => void;
}) {
  const humanContext=contextInput??api.humanContext??undefined,projectId=projectInput??api.projectId??undefined;
  const humanChoices=useHumanGraderChoices(humanContext,projectId,humanDataset),humanGraders=humanChoices.choices;
  const [humanReview,setHumanReview]=useState<HumanReviewView|null>(null),[humanError,setHumanError]=useState<string|null>(null);
  async function openHuman(id:string){if(!humanContext)return;try{setHumanReview(await humanApi.get(humanContext,id));}catch(e){setHumanError(e instanceof Error?e.message:"Review unavailable.");}}
  const [selected, setSelected] = useState<string | null>(null),
    [after, setAfter] = useState<number>();
  const controls = useWorkspacePanelControls(),
    member = result.cases.find((row) => row.receiptId === selected);
  useWorkspaceActions(member ? [{ id: "case", label: "Case", onSelect: () => {} }] : []);
  const inspection = useQuery({
    queryKey: ["local-experiments", api.key, "case", result.execution.id, selected, after],
    enabled: Boolean(member),
    refetchInterval:member?.status==="running"?2000:false,
    queryFn: ({ signal }) =>
      localRequest(
        api,
        LocalExperimentCaseInspectionSchema,
        "case",
        {
          id: result.execution.id,
          receiptId: selected,
          ...(after ? { afterSequence: after } : {}),
        },
        signal,
      ),
  });
  const initialTrace=useQuery({queryKey:["local-experiments",api.key,"process-session",result.execution.id,selected],enabled:Boolean(member&&member.status==="running"),refetchInterval:member?.status==="running"?2000:false,queryFn:({signal})=>localRequest(api,LocalExperimentCaseInspectionSchema,"case",{id:result.execution.id,receiptId:selected,limit:100},signal)});
  const started=initialTrace.data?.trace.items.find(event=>event.type==="external.start"),session=started?z.object({provider:z.literal("claude-code"),sessionId:z.uuid(),holdOpen:z.boolean()}).safeParse(started.payload):null;
  const processSession=member?.externalProcess?.sessionId??(session?.success?session.data.sessionId:undefined);
  useEffect(()=>{setSelected(null);setAfter(undefined);setHumanReview(null);setHumanError(null);},[api.key,result.execution.id]);
  function inspect(id: string) {
    setSelected(id);
    setAfter(undefined);
    controls?.select({ id: "case", label: "Case", onSelect: () => {} });
  }
  return (
    <>
      <p>{result.cases.length} retained local cases</p>
      <table className="training-data-table evaluation-workspace-table">
        <thead>
          <tr>
            <th>Task</th>
            <th>Seed</th>
            <th>Status</th>
            <th>Overall score</th>
          </tr>
        </thead>
        <tbody>
          {result.cases.map((row) => (
            <tr
              key={row.receiptId}
              tabIndex={0}
              onClick={() => inspect(row.receiptId)}
              onKeyDown={(event) => {
                if (event.key === "Enter") inspect(row.receiptId);
              }}
            >
              <td>{row.taskId}</td>
              <td>{row.seed}</td>
              <td>
                <EvaluationStatus status={row.status} />
              </td>
              <td>{row.grade?.score ?? "Unavailable"}</td>
            </tr>
          ))}
          <EvaluationTableState columns={4} empty={!result.cases.length}>
            Run an Experiment to retain case results here.
          </EvaluationTableState>
        </tbody>
      </table>
      {member ? (
        <WorkspacePanel
          action="case"
          label="Local case inspector"
          onRequestClose={() => setSelected(null)}
        >
          <header>
            <h2>{member.taskId}</h2>
          {humanContext && projectId?<HumanReviewLaunch context={humanContext} projectId={projectId} selections={[{executionId:result.execution.id,receiptId:member.receiptId}]} graders={humanGraders} onOpenReview={setHumanReview}/>:null}
          </header>
          {processSession?<ClaudeProcessControls key={`${api.key}:${result.execution.id}:${member.receiptId}:${processSession}`} api={api} executionId={result.execution.id} receiptId={member.receiptId} sessionId={processSession} active={member.status==="running"&&Boolean(session?.success&&session.data.holdOpen)} onChanged={()=>{void inspection.refetch();void initialTrace.refetch();}}/>:null}
          {member.externalProcess?<EvaluationCard title="Sealed process receipt"><dl><dt>Session</dt><dd>{member.externalProcess.sessionId}</dd><dt>Interface</dt><dd>{member.externalProcess.runtime.version}</dd><dt>Retained events</dt><dd>{member.externalProcess.eventCount}</dd><dt>Trace hash</dt><dd>{member.externalProcess.traceHash}</dd><dt>Cleanup</dt><dd>Confirmed by the process owner</dd></dl></EvaluationCard>:null}
          <EvaluationCard title="Retained input">
            <pre>
              {JSON.stringify(
                { input: member.input, context: member.policyVisibleContext },
                null,
                2,
              )}
            </pre>
          </EvaluationCard>
          <EvaluationCard title="Output">
            <pre>{member.output ?? "No completed output retained."}</pre>
            {member.error ? <p role="alert">{member.error}</p> : null}
          </EvaluationCard>
          <EvaluationCard title="Grading">
            {graders.map((grader) => (
              <ExperimentGraderLabel key={grader.id} grader={grader} onOpen={onOpenGrader} />
            ))}
            <pre>{JSON.stringify(member.grade, null, 2)}</pre>
          </EvaluationCard>
          <EvaluationCard title="Available trace">
            {inspection.error ? <p role="alert">{inspection.error.message}</p> : null}
            {inspection.isPending ? (
              <p>Loading retained trace…</p>
            ) : inspection.data?.trace.items.length ? (
              <ol>
                {inspection.data.trace.items.map((event) => (
                  <li key={event.sequence}>
                    <strong>
                      {event.sequence}, {event.type}
                    </strong>
                    <pre>{JSON.stringify(event.payload, null, 2)}</pre>
                  </li>
                ))}
              </ol>
            ) : (
              <p>No model trace events retained.</p>
            )}
            {after ? (
              <button type="button" onClick={() => setAfter(undefined)}>
                First trace page
              </button>
            ) : null}
            {inspection.data?.trace.nextCursor ? (
              <button type="button" onClick={() => setAfter(inspection.data!.trace.nextCursor!)}>
                Next trace page
              </button>
            ) : null}
            {member.profileNative ? (
              <EvaluationCard title="Profile execution evidence">
                <pre>{JSON.stringify(member.profileNative, null, 2)}</pre>
              </EvaluationCard>
            ) : null}
            {member.native ? (
              <details>
                <summary>Native turn evidence</summary>
                <pre>{JSON.stringify(member.native, null, 2)}</pre>
              </details>
            ) : null}
          </EvaluationCard>
        </WorkspacePanel>
      ) : null}
      {humanError?<p role="alert">{humanError}</p>:null}
      {humanContext?<LocalPublishedHumanResults context={humanContext} executionId={result.execution.id} onOpenReview={setHumanReview}/>:null}
      {humanContext ? <HumanResultControls context={humanContext} executionId={result.execution.id} onOpenReview={id=>void openHuman(id)}/>:null}
      {humanContext&&humanReview?<WorkspacePanel action="human-review" label={humanReview.title} onRequestClose={()=>setHumanReview(null)}><HumanReviewInspector context={humanReview.evidence?.publication&&humanReview.evidence.attempts.some(attempt=>attempt.localSource)?{...humanContext,location:"hosted"}:humanContext} record={humanReview} onChanged={setHumanReview} onClose={()=>setHumanReview(null)}/></WorkspacePanel>:null}
    </>
  );
}
