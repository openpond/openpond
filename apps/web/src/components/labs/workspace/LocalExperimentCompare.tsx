import { useState } from "react";
import { useInfiniteQuery, useQuery } from "@tanstack/react-query";
import { compareExperiments, experimentCaseKey } from "@openpond/evals/experiments";
import { LocalExperimentComparisonSchema, LocalExperimentRecordPageSchema, type LocalExperimentRecord } from "@openpond/contracts";
import { localRequest } from "./local-workspace-api";
import { EvaluationTime, evaluationRelativeTime } from "./EvaluationPresentation";
import { EvaluationTableState } from "./EvaluationTableState";
import type { WorkspaceApi } from "./workspace-api";

const number = (value: number | null) => value === null ? "Unavailable" : value.toLocaleString(undefined, { maximumFractionDigits: 6 });

export function LocalExperimentCompare({ api, baselineId }: {
  api: WorkspaceApi; baselineId: string | null; executions?: LocalExperimentRecord[];
}) {
  const collection=useInfiniteQuery({queryKey:["local-experiments",api.key,"compareCandidates"],initialPageParam:undefined as string|undefined,
    queryFn:({signal,pageParam})=>localRequest(api,LocalExperimentRecordPageSchema,"list",{...(api.projectId?{projectId:api.projectId}:{}),...(pageParam?{afterId:pageParam}:{})},signal),getNextPageParam:page=>page.nextCursor??undefined});
  const executions=collection.data?.pages.flatMap(page=>page.items)??[];
  const [candidateId, setCandidateId] = useState("");
  const [feedbackKey, setFeedbackKey] = useState("");
  const comparison = useQuery({
    queryKey: ["local-experiments", api.key, "compare", baselineId, candidateId],
    enabled: Boolean(baselineId && candidateId),
    queryFn: async ({ signal }) => {
      const evidence = await localRequest(api, LocalExperimentComparisonSchema, "compare", { baselineId, candidateId }, signal);
      return compareExperiments(evidence.baseline, evidence.candidate);
    },
  });
  const candidate = executions.find(item => item.id === candidateId);
  const data = comparison.data;
  const selectedKey = data?.metrics.some(metric => metric.feedbackKey === feedbackKey)
    ? feedbackKey : data?.metrics[0]?.feedbackKey ?? "";
  return (
    <section aria-label="Compare local executions">
      <label>
        Candidate execution
        <select value={candidateId} onChange={event => { setCandidateId(event.target.value); setFeedbackKey(""); }}>
          <option value="">Choose retained execution</option>
          {executions.filter(item => item.id !== baselineId && item.completedAt && item.cleanupComplete).map(item => (
            <option key={item.id} value={item.id}>{evaluationRelativeTime(item.createdAt)} · {item.status} · {item.id}</option>
          ))}
        </select>
      </label>
      {collection.hasNextPage?<button disabled={collection.isFetchingNextPage} onClick={()=>void collection.fetchNextPage()}>More experiments</button>:null}{collection.error?<p role="alert">{collection.error.message}</p>:null}
      {candidate ? <p>Started <EvaluationTime value={candidate.createdAt} /></p> : null}
      {data ? <>
        <p role="status">{data.comparable ? "Compatible retained populations" : "Comparison unavailable for these results"}</p>
        {data.reasons.length ? <ul>{data.reasons.map(reason => <li key={reason}>{reason.replaceAll("_", " ")}</li>)}</ul> : null}
      </> : null}
      <table className="training-data-table evaluation-workspace-table">
        <thead><tr><th>Feedback key</th><th>Baseline</th><th>Candidate</th><th>Change</th><th>Eligible</th><th>Excluded</th></tr></thead>
        <tbody>
          <EvaluationTableState columns={6} loading={comparison.isFetching && !data} error={comparison.error?.message}
            empty={!data?.metrics.length} retry={() => void comparison.refetch()}>
            Choose two completed executions to compare retained scores.
          </EvaluationTableState>
          {data?.metrics.map(metric => <tr key={metric.feedbackKey}>
            <td>{metric.feedbackKey}</td><td>{number(metric.baseline)}</td><td>{number(metric.candidate)}</td>
            <td>{number(metric.delta)}</td><td>{metric.eligibleCount}</td><td>{metric.excludedCount}</td>
          </tr>)}
        </tbody>
      </table>
      {data ? <>
        <label>Case feedback<select value={selectedKey} onChange={event => setFeedbackKey(event.target.value)}>
          {data.metrics.map(metric => <option value={metric.feedbackKey} key={metric.feedbackKey}>{metric.feedbackKey}</option>)}
        </select></label>
        <table className="training-data-table evaluation-workspace-table">
          <thead><tr><th>Task/seed</th><th>Baseline</th><th>Candidate</th><th>Change</th><th>Eligibility</th><th>Output changed</th></tr></thead>
          <tbody>{data.cases.map(row => {
            const feedback = row.feedback.find(item => item.feedbackKey === selectedKey);
            return <tr key={experimentCaseKey(row.identity)}>
              <td>{row.identity.caseId} · {row.identity.seed}</td><td>{number(feedback?.baseline ?? null)}</td>
              <td>{number(feedback?.candidate ?? null)}</td><td>{number(feedback?.delta ?? null)}</td>
              <td>{feedback?.eligible ? "Eligible" : feedback?.reason?.replaceAll("_", " ") ?? "Unavailable feedback"}</td>
              <td>{row.baseline && row.candidate ? row.baseline.output === row.candidate.output ? "No" : "Yes" : "Unavailable"}</td>
            </tr>;
          })}</tbody>
        </table>
      </> : null}
    </section>
  );
}
