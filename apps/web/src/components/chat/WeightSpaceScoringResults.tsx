import { useState } from "react";
import { useInfiniteQuery, useMutation, useQuery } from "@tanstack/react-query";
import { ErrorToast } from "../common/ErrorToast";
import { LabStatusBadge } from "../labs/LabStatusBadge";
import { ScoringPassStatus } from "../labs/workspace/ScoringPassStatus";
import type { managedWeightSpaceApi } from "../labs/workspace/managed-weight-space-api";

/** Graders consume retained outputs. This view cannot start model inference,
 * change a candidate or reopen the closed held-out boundary. */
export function WeightSpaceScoringResults({client,scopeKey,id,active}:{
  client:ReturnType<typeof managedWeightSpaceApi>;scopeKey:string;id:string;active:boolean;
}){
  const [selectedId,setSelectedId]=useState("");
  const pages=useInfiniteQuery({queryKey:["weight-space-grading",scopeKey,id,"pages"],initialPageParam:undefined as string|undefined,
    queryFn:({pageParam,signal})=>client.scoringPasses(id,pageParam,signal),getNextPageParam:page=>page.nextCursor??undefined,retry:false,
    refetchInterval:query=>!query.state.error&&(active||query.state.data?.pages.some(page=>page.items.some(pass=>["queued","running","cancelling"].includes(pass.status))))?5_000:false});
  const passes=[...new Map((pages.data?.pages.flatMap(page=>page.items)??[]).map(pass=>[pass.id,pass])).values()];
  const selected=passes.find(pass=>pass.id===selectedId);
  const evidence=useQuery({queryKey:["weight-space-grading",scopeKey,id,"result",selected?.id],enabled:!!selected?.resultAvailable,retry:false,
    queryFn:({signal})=>client.scoringResult(id,selected!,signal)});
  const cancel=useMutation({mutationFn:(passId:string)=>client.cancelScoringPass(id,passId),onSuccess:()=>pages.refetch()});
  return <section className="training-detail-section" aria-label="Graded results"><h3>Graded results</h3>
    <ErrorToast error={pages.error??evidence.error??cancel.error}/>
    <p>These grades use the selected evaluation’s recorded outputs.</p>
    {pages.isPending?<p role="status">Loading grading passes…</p>:null}
    {!passes.length&&!pages.isPending&&!pages.error?<p>No grading passes yet. The agent can apply your selected graders to a retained evaluation.</p>:null}
    {passes.length?<div className="evaluation-table-scroll evaluation-table-frame"><table className="training-data-table evaluation-workspace-table">
      <thead><tr><th>Target</th><th>Graders</th><th>Progress</th><th>Details</th></tr></thead>
      <tbody>{passes.map(pass=><tr key={pass.id}><td>{pass.request.weightSpaceTarget==="baseline"?"Original model":"Evaluated candidate"}</td>
        <td>{pass.graders.map(grader=>grader.name??grader.id).join(", ")}</td><td><LabStatusBadge label={pass.status}/>{pass.counts.scored} / {pass.totalCount}</td>
        <td><button className="training-button secondary" onClick={()=>setSelectedId(pass.id)} aria-pressed={selected?.id===pass.id}>View</button></td></tr>)}</tbody>
    </table></div>:null}
    {pages.hasNextPage?<button className="training-button secondary" disabled={pages.isFetchingNextPage} onClick={()=>void pages.fetchNextPage()}>More grading passes</button>:null}
    {selected?<><ScoringPassStatus pass={selected} busy={cancel.isPending} onCancel={()=>cancel.mutate(selected.id)}/>
      <details><summary>Original evaluation</summary><p className="saved-model-version-reference">{selected.request.weightSpaceOperationId}</p></details>
      {selected.resultAvailable&&evidence.isPending?<p role="status">Loading saved grading results…</p>:null}
      {!evidence.error?evidence.data?.result.cases.map(row=><details key={JSON.stringify(row.identity)}><summary>{row.identity.caseId} · {row.status}</summary>
        <pre className="saved-model-version-reference">{typeof row.output==="string"?row.output:JSON.stringify(row.output,null,2)}</pre>
        {row.feedback.map(feedback=><div key={feedback.feedbackKey}><h4>{selected.graders.find(grader=>grader.feedbackKey===feedback.feedbackKey)?.name??feedback.feedbackKey}</h4>
          <p>{feedback.status}: {feedback.value===null?"Unavailable":typeof feedback.value==="boolean"?feedback.value?"Passed":"Failed":String(feedback.value)}</p>
          {feedback.reasoning?<p>{feedback.reasoning}</p>:null}</div>)}
        {row.error?<p>Retained outcome: {row.error.message}</p>:null}
      </details>):null}</>:null}
  </section>;
}
