import "./weight-space-session.css";
import { WeightSpaceEvaluationComparison } from "./WeightSpaceEvaluationComparison";
import { WeightSpaceScoringResults } from "./WeightSpaceScoringResults";
import { WeightSpaceEvaluationOutput } from "./WeightSpaceEvaluationOutput";
import { useCancelWeightSpace } from "../labs/useCancelWeightSpace";
import { Fragment, useContext, useMemo, useState } from "react";
import { useInfiniteQuery, useQuery, useQueryClient } from "@tanstack/react-query";
import type { WeightSpaceExecution } from "openpond-sdk/training";
import type { ClientConnection } from "../../api";
import { ChatContextAccountScope } from "../../hooks/useChatContextSelection";
import { createWorkspaceApi } from "../labs/workspace/workspace-api";
import { managedWeightSpaceApi } from "../labs/workspace/managed-weight-space-api";
import { WeightSpaceModelSave } from "../labs/WeightSpaceModelSave";
import { ErrorToast } from "../common/ErrorToast";
import { LabStatusBadge } from "../labs/LabStatusBadge";

/** The chat retains an identity; observations come from its authenticated owner.
 * Tensor output is expanded on demand and never contains the full checkpoint. */
export function WeightSpaceSessionPanel({connection,apiOrigin,initial,accountKey:providedAccountKey}:{connection:ClientConnection;apiOrigin:string;initial:WeightSpaceExecution;accountKey?:string}){
  const queryClient=useQueryClient();
  const contextAccountKey=useContext(ChatContextAccountScope),accountKey=providedAccountKey??contextAccountKey;
  const api=useMemo(()=>createWorkspaceApi(connection,{accountKey,teamId:initial.teamId,actorId:initial.ownerUserId,projectId:initial.projectId}),
    [connection,accountKey,initial.teamId,initial.ownerUserId,initial.projectId]);
  const client=useMemo(()=>managedWeightSpaceApi(api,apiOrigin),[api,apiOrigin]);
  const source=useQuery({queryKey:["weight-space-session",api.key,apiOrigin,initial.id],initialData:initial,
    queryFn:({signal})=>client.get(initial.id,signal),retry:false,
    refetchInterval:query=>!query.state.error&&["queued","dispatching","stopping"].includes(query.state.data?.phase??"")?5_000:false,
    refetchIntervalInBackground:false});
  const execution=source.data,session=execution.session;
  const cancellation=useCancelWeightSpace(api,apiOrigin,execution,()=>void source.refetch());
  const [earlierHistory,setEarlierHistory]=useState(false);
  const afterRevision=earlierHistory?0:Math.max(0,(session?.revision??1)-6);
  const history=useInfiniteQuery({queryKey:["weight-space-history",api.key,apiOrigin,initial.id,session?.revision,earlierHistory],initialPageParam:afterRevision,
    queryFn:({pageParam,signal})=>client.history(initial.id,pageParam,signal),getNextPageParam:page=>page.nextAfterRevision??undefined,retry:false});
  const receipts=history.data?.pages.flatMap(page=>page.items)??[];
  const latest=receipts.flatMap(row=>row.result&&row.result.candidateHash===session?.candidateHash?[row.result]:[]).at(-1);
  return <div className="chat-experiment-tool-content weight-space-session">
    <ErrorToast error={source.error??history.error??cancellation.error}/>
    <div className="labs-project-trends-heading"><h2>{execution.name}</h2><LabStatusBadge label={session?.phase??execution.phase}/></div>
    <p>Weight-space programming</p>
    <dl className="training-context-facts">
      <dt>Base model</dt><dd>{execution.request.model.modelId}</dd>
      <dt>Runtime</dt><dd>Remote GPU worker · CPU tensor analysis</dd>
      <dt>Teacher</dt><dd>{execution.request.teacher.modelId} · local agent</dd>
      <dt>Objective</dt><dd>{execution.request.objective}</dd>
      <dt>Candidate</dt><dd className="saved-model-version-reference">{session?.candidateHash??"Waiting for remote session"}</dd>
      <dt>Commands</dt><dd>{session?.usage.commands??0} / {execution.request.limits.maximumCommands}</dd>
      <dt>Candidates</dt><dd>{session?.usage.candidates??0} / {execution.request.limits.maximumCandidates}</dd>
      <dt>Forward work</dt><dd>{session?.usage.forwardTokenWork??0} / {execution.request.limits.maximumForwardTokenWork}</dd>
      <dt>Spend limit</dt><dd>${execution.plan.maximumSpendUsd}</dd>
    </dl>
    <button type="button" className="training-button secondary" disabled={source.isFetching||history.isFetching} onClick={()=>{void source.refetch();void history.refetch();void queryClient.invalidateQueries({queryKey:["weight-space-grading",client.cacheKey,initial.id]});}}>Refresh session and results</button>
    {latest?.changedColumns.length?<details><summary>Changed parameters</summary><dl className="training-context-facts">{latest.changedColumns.map(row=><Fragment key={row.layer}><dt>Layer {row.layer} · MLP down projection</dt><dd>{row.columns.join(", ")}</dd></Fragment>)}</dl></details>:null}
    <div className="model-build-actions"><button type="button" className="training-button secondary" disabled={cancellation.busy||!cancellation.enabled||Boolean(source.error)&&!cancellation.original} onClick={()=>void cancellation.cancel()}>{cancellation.busy?"Cancelling…":cancellation.original?"Recover cancellation":"Cancel session"}</button>{cancellation.error?<button className="training-button secondary" onClick={cancellation.reload}>Reload retained cancellations</button>:null}</div>
    <WeightSpaceEvaluationComparison results={receipts.flatMap(row=>row.result?[row.result]:[])}/>
    <WeightSpaceScoringResults key={`${client.cacheKey}:${initial.id}`} client={client} scopeKey={client.cacheKey} id={initial.id} active={["queued","dispatching","stopping"].includes(execution.phase)}/>
    <section className="training-detail-section" aria-label="Editing history"><h3>Editing history</h3>
      {afterRevision>0?<button className="training-button secondary" onClick={()=>setEarlierHistory(true)}>Read earlier history</button>:earlierHistory?<button className="training-button secondary" onClick={()=>setEarlierHistory(false)}>Return to recent commands</button>:null}
      {!receipts.length&&!history.isPending&&!history.error?<p>No retained commands yet. The local agent can inspect tensors and submit an edit after the remote session is ready.</p>:null}
      {receipts.map(receipt=><details key={receipt.command.operationId}><summary>{receipt.command.expectedRevision} · {receipt.command.action} · {receipt.result?.status??receipt.state}</summary>
        {"hypothesis" in receipt.command?<p>{receipt.command.hypothesis}</p>:null}
        {receipt.result?.code?<p>Retained outcome: {receipt.result.code}</p>:null}
        <dl className="training-context-facts"><dt>Candidate</dt><dd className="saved-model-version-reference">{receipt.result?.candidateHash??receipt.command.candidateHash}</dd></dl>
        {receipt.result?.evaluation?<><h4>{receipt.result.evaluation.role} · {receipt.result.evaluation.panelId}</h4>{receipt.result.evaluation.rows.map(row=><details key={row.id}><summary>{row.id}{row.reachedTokenLimit?" · token limit reached":""}</summary><pre className="saved-model-version-reference">{row.outputText}</pre></details>)}</>:null}
        {session?.phase==="closed"&&receipt.result?.finalEvaluation?<><h4>Final held-out comparison</h4>
          {receipt.result.finalEvaluation.rows.map((row,index)=><details key={row.id}><summary>{row.id}</summary>
            <WeightSpaceEvaluationOutput label="Original model" output={receipt.result!.finalEvaluation!.baseline.rows[index]!}/>
            <WeightSpaceEvaluationOutput label="Selected candidate" output={row}/>
          </details>)}</>:null}
        {receipt.result&&Object.keys(receipt.result.tensors).length?<details><summary>Bounded tensor inspection</summary>{Object.entries(receipt.result.tensors).map(([name,tensor])=><section key={name}><h4>{name}</h4><dl className="training-context-facts"><dt>Shape</dt><dd>{tensor.shape.join(" × ")}</dd><dt>Range</dt><dd>{tensor.minimum} to {tensor.maximum}</dd><dt>Mean</dt><dd>{tensor.mean}</dd><dt>Norm</dt><dd>{tensor.norm}</dd></dl><p>{tensor.truncated?`Showing the first ${tensor.values.length} values.`:"Values"}</p><pre className="saved-model-version-reference">{tensor.values.join(", ")}</pre></section>)}</details>:null}
        {receipt.result?.catalog?<details><summary>Tensor catalog</summary><div className="evaluation-table-scroll evaluation-table-frame"><table className="training-data-table evaluation-workspace-table"><thead><tr><th>Tensor</th><th>Shape</th><th>Editable</th></tr></thead><tbody>{receipt.result.catalog.items.map(tensor=><tr key={tensor.name}><td>{tensor.name}</td><td>{tensor.shape.join(" × ")}</td><td>{tensor.editable?"Selected columns":"Read only"}</td></tr>)}</tbody></table></div>{receipt.result.catalog.nextOffset!==null?<p>More tensors are available through the agent’s next catalog request.</p>:null}</details>:null}
        <details><summary>Original command and receipt</summary><pre className="saved-model-version-reference">{JSON.stringify(receipt,null,2)}</pre></details>
      </details>)}
      {history.hasNextPage?<button className="training-button secondary" disabled={history.isFetchingNextPage} onClick={()=>void history.fetchNextPage()}>More history</button>:null}
    </section>
    <WeightSpaceModelSave key={`${api.key}:${initial.id}`} api={api} id={initial.id} execution={source.error?undefined:execution}/>
  </div>;
}
