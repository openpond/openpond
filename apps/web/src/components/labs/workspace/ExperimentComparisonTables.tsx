import {useState} from "react";
import {HumanReviewLaunch} from "../../human-review/HumanReviewLaunch";
import {LocalPublishedHumanResults} from "../../human-review/LocalPublishedHumanResults";
import {HumanReviewInspector} from "../../human-review/HumanReviewInspector";
import {useHumanGraderChoices} from "../../human-review/useHumanGraderChoices";
import type {HumanInboxContext} from "../../human-review/api";
import type {HumanReviewView} from "@openpond/evals/human-review";
import {WorkspacePanel} from "./WorkspacePanel";
import type { compareExperiments } from "@openpond/evals/experiments";
import type { ExperimentGraderPin } from "openpond-sdk/experiments";
import { EvaluationTableState } from "./EvaluationTableState";
import { ExperimentGraderLabel, experimentGraderName } from "./ExperimentGraderLabel";

type Comparison = ReturnType<typeof compareExperiments>;
const number = (value: number | null) =>
  value === null ? "Unavailable" : value.toLocaleString(undefined, { maximumFractionDigits: 6 });
export function ExperimentComparisonTables({
  data,
  loading,
  error,
  retry,
  graders,
  onOpenGrader,
  feedbackKey,
  onFeedbackKey,human,
}: {
  human?:{context:HumanInboxContext;projectId:string;dataset:{id:string;revision:number;contentHash:string};selections:(identity:Comparison["cases"][number]["identity"])=>{executionId:string;receiptId:string}[]};
  data?: Comparison;
  loading: boolean;
  error?: string | null;
  retry: () => void;
  graders: ExperimentGraderPin[];
  onOpenGrader?: (release: NonNullable<ExperimentGraderPin["release"]>) => void;
  feedbackKey: string;
  onFeedbackKey: (key: string) => void;
}) {
  const [review,setReview]=useState<HumanReviewView|null>(null),choices=useHumanGraderChoices(human?.context,human?.projectId,human?.dataset);
  const selectedKey = data?.metrics.some((metric) => metric.feedbackKey === feedbackKey)
    ? feedbackKey
    : (data?.metrics[0]?.feedbackKey ?? "");
  return (
    <>
      <table className="training-data-table evaluation-workspace-table">
        <thead>
          <tr>
            <th>Grader</th>
            <th>Baseline</th>
            <th>Candidate</th>
            <th>Score change</th>
            <th>Pass-rate change</th>
            <th>Eligible</th>
            <th>Excluded</th>
          </tr>
        </thead>
        <tbody>
          {!data?.metrics.length ? (
            <EvaluationTableState columns={7} loading={loading} error={error} empty retry={retry}>
              Choose completed Experiments and compare their retained results to see Grader scores.
            </EvaluationTableState>
          ) : null}
          {data?.metrics.map((metric) => {
            const grader = graders.find((item) => item.feedbackKey === metric.feedbackKey);
            return (
              <tr key={metric.feedbackKey}>
                <td>
                  {grader ? (
                    <ExperimentGraderLabel grader={grader} onOpen={onOpenGrader} />
                  ) : (
                    experimentGraderName(graders, metric.feedbackKey)
                  )}
                  <div>
                    <small>{metric.feedbackKey}</small>
                  </div>
                </td>
                <td>{number(metric.baseline)}</td>
                <td>{number(metric.candidate)}</td>
                <td>{number(metric.delta)}</td>
                <td>{number(metric.passRateDelta)}</td>
                <td>{metric.eligibleCount}</td>
                <td>{metric.excludedCount}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
      {data?.metrics.length ? (
        <label>
          Case Grader
          <select value={selectedKey} onChange={(event) => onFeedbackKey(event.target.value)}>
            {data.metrics.map((metric) => (
              <option value={metric.feedbackKey} key={metric.feedbackKey}>
                {experimentGraderName(graders, metric.feedbackKey)}
              </option>
            ))}
          </select>
        </label>
      ) : null}
      <table className="training-data-table evaluation-workspace-table">
        <thead>
          <tr>
            <th>Task / seed</th>
            <th>Baseline</th>
            <th>Candidate</th>
            <th>Change</th>
            <th>Eligibility</th>
            <th>Output changed</th>
          </tr>
        </thead>
        <tbody>
          {!data?.cases.length ? (
            <EvaluationTableState columns={6} loading={loading} error={error} empty retry={retry}>
              Compare retained Experiments to inspect matching task and seed results.
            </EvaluationTableState>
          ) : null}
          {data?.cases.map((row) => {
            const feedback = row.feedback.find((item) => item.feedbackKey === selectedKey);
            return (
              <tr key={JSON.stringify(row.identity)}>
                <td>
                  {row.identity.caseId} / Seed {row.identity.seed}
                  {human&&row.baseline&&row.candidate?<HumanReviewLaunch context={human.context} projectId={human.projectId} selections={human.selections(row.identity)} graders={choices.choices.filter(c=>c.mode==="pairwise")} onOpenReview={setReview}/>:null}
                </td>
                <td>{number(feedback?.baseline ?? null)}</td>
                <td>{number(feedback?.candidate ?? null)}</td>
                <td>{number(feedback?.delta ?? null)}</td>
                <td>
                  {feedback?.eligible
                    ? "Eligible"
                    : (feedback?.reason?.replaceAll("_", " ") ?? "Unavailable feedback")}
                </td>
                <td>
                  {row.baseline && row.candidate
                    ? row.baseline.output === row.candidate.output
                      ? "No"
                      : "Yes"
                    : "Unavailable"}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
      {data && error ? (
        <p role="alert">
          {error}
          <button type="button" onClick={retry}>
            Retry comparison
          </button>
        </p>
      ) : null}
      {human?.context.location==="local"&&data?.cases[0]?human.selections(data.cases[0].identity).map(selection=><LocalPublishedHumanResults key={selection.executionId} context={human.context} executionId={selection.executionId} onOpenReview={setReview}/>):null}
      {human&&review?<WorkspacePanel action="human-review" label={review.title} onRequestClose={()=>setReview(null)}><HumanReviewInspector context={review.evidence?.publication&&review.evidence.attempts.some(attempt=>attempt.localSource)?{...human.context,location:"hosted"}:human.context} record={review} onChanged={setReview} onClose={()=>setReview(null)}/></WorkspacePanel>:null}
    </>
  );
}
